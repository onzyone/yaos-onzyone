/**
 * Plugin-side snapshot client.
 *
 * Communicates with the server's snapshot endpoints to:
 *   - Trigger daily/on-demand snapshots
 *   - List available snapshots
 *   - Download snapshot CRDT data for restore
 *   - Diff snapshot state against current CRDT
 *   - Restore selected files (soft restore: replace Y.Text content)
 */

import * as Y from "yjs";
import { gunzipSync } from "fflate";
import type { VaultSyncSettings } from "../settings";
import type { FileMeta, BlobRef } from "../types";
import { appendTraceParams, type TraceHttpContext } from "../debug/trace";

// -------------------------------------------------------------------
// Types (mirrors server SnapshotIndex)
// -------------------------------------------------------------------

export interface SnapshotIndex {
	snapshotId: string;
	vaultId: string;
	createdAt: string;
	day: string;
	schemaVersion: number | undefined;
	markdownFileCount: number;
	blobFileCount: number;
	crdtSizeBytes: number;
	crdtRawSizeBytes: number;
	referencedBlobHashes: string[];
	triggeredBy?: string;
}

export interface SnapshotResult {
	status: "created" | "noop" | "unavailable";
	snapshotId?: string;
	snapshotKey?: string;
	reason?: string;
	index?: SnapshotIndex;
	error?: string;
}

/**
 * Diff between a snapshot and the current CRDT state.
 */
export interface SnapshotDiff {
	/** Files present in snapshot but not in current CRDT (deleted since snapshot). */
	deletedSinceSnapshot: Array<{ path: string; fileId: string }>;
	/** Files present in current CRDT but not in snapshot (created since snapshot). */
	createdSinceSnapshot: string[];
	/** Files present in both but with different content. */
	contentChanged: Array<{ path: string; fileId: string; snapshotContent: string; currentContent: string }>;
	/** Files present in both with identical content. */
	unchanged: string[];
	/** Blob paths in snapshot but not in current state. */
	blobsDeletedSinceSnapshot: Array<{ path: string; hash: string }>;
	/** Blob paths in current state but not in snapshot. */
	blobsCreatedSinceSnapshot: string[];
	/** Blob paths with different hashes. */
	blobsChanged: Array<{ path: string; snapshotHash: string; currentHash: string }>;
}

// -------------------------------------------------------------------
// HTTP client
// -------------------------------------------------------------------

/**
 * Build the base URL for server HTTP endpoints.
 */
function baseUrl(settings: VaultSyncSettings): string {
	const host = settings.host.replace(/\/$/, "");
	const roomId = `v1:${settings.vaultId}`;
	// PartyKit HTTP endpoint format: host/parties/main/<roomId>
	// IMPORTANT: do not URL-encode roomId here. The websocket provider uses
	// the raw room id (v1:<vaultId>), and encoding would route HTTP endpoints
	// to a different DO room (v1%3A...) than the live Yjs websocket room.
	return `${host}/parties/main/${roomId}`;
}

async function serverPost(
	settings: VaultSyncSettings,
	endpoint: string,
	body?: Record<string, unknown>,
	trace?: TraceHttpContext,
): Promise<unknown> {
	const url = appendTraceParams(
		`${baseUrl(settings)}/${endpoint}`,
		trace,
	);
	const res = await fetch(url, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${settings.token}`,
		},
		body: body ? JSON.stringify(body) : "{}",
	});
	if (!res.ok) {
		const text = await res.text();
		throw new Error(`Server ${endpoint} failed (${res.status}): ${text}`);
	}
	return res.json();
}

async function serverGet(
	settings: VaultSyncSettings,
	endpoint: string,
	trace?: TraceHttpContext,
): Promise<unknown> {
	const url = appendTraceParams(
		`${baseUrl(settings)}/${endpoint}`,
		trace,
	);
	const res = await fetch(url, {
		method: "GET",
		headers: {
			Authorization: `Bearer ${settings.token}`,
		},
	});
	if (!res.ok) {
		const text = await res.text();
		throw new Error(`Server ${endpoint} failed (${res.status}): ${text}`);
	}
	return res.json();
}

// -------------------------------------------------------------------
// Snapshot triggers
// -------------------------------------------------------------------

/**
 * Request a daily snapshot (noop if already done today).
 */
export async function requestDailySnapshot(
	settings: VaultSyncSettings,
	device?: string,
	trace?: TraceHttpContext,
): Promise<SnapshotResult> {
	return await serverPost(settings, "snapshot/maybe", { device }, trace) as SnapshotResult;
}

/**
 * Force-create a snapshot right now.
 */
export async function requestSnapshotNow(
	settings: VaultSyncSettings,
	device?: string,
	trace?: TraceHttpContext,
): Promise<SnapshotResult> {
	return await serverPost(settings, "snapshot/now", { device }, trace) as SnapshotResult;
}

// -------------------------------------------------------------------
// Snapshot listing
// -------------------------------------------------------------------

/**
 * List all available snapshots, newest first.
 */
export async function listSnapshots(
	settings: VaultSyncSettings,
	trace?: TraceHttpContext,
): Promise<SnapshotIndex[]> {
	const result = await serverGet(settings, "snapshot/list", trace) as { snapshots: SnapshotIndex[] };
	return result.snapshots ?? [];
}

// -------------------------------------------------------------------
// Snapshot download + decode
// -------------------------------------------------------------------

/**
 * Download and decode a snapshot's CRDT data into a temporary Y.Doc.
 * The returned doc is a standalone offline doc — not connected to any provider.
 */
export async function downloadSnapshot(
	settings: VaultSyncSettings,
	snapshot: SnapshotIndex,
	trace?: TraceHttpContext,
): Promise<Y.Doc> {
	// Get presigned URL for the crdt.bin.gz
	const presignResult = await serverPost(settings, "snapshot/presign-get", {
		snapshotId: snapshot.snapshotId,
		day: snapshot.day,
	}, trace) as { url: string; expiresIn: number };

	// Download the gzipped CRDT data
	const res = await fetch(presignResult.url);
	if (!res.ok) {
		throw new Error(`Snapshot download failed (${res.status})`);
	}

	const compressed = new Uint8Array(await res.arrayBuffer());

	// Decompress
	const rawUpdate = gunzipSync(compressed);

	// Apply to a fresh Y.Doc
	const snapshotDoc = new Y.Doc();
	Y.applyUpdate(snapshotDoc, rawUpdate);

	return snapshotDoc;
}

// -------------------------------------------------------------------
// Diff
// -------------------------------------------------------------------

/**
 * Compute a diff between a snapshot Y.Doc and the live Y.Doc.
 * Returns structured information about what changed.
 */
export function diffSnapshot(
	snapshotDoc: Y.Doc,
	liveDoc: Y.Doc,
): SnapshotDiff {
	const snapPathToId = snapshotDoc.getMap<string>("pathToId");
	const snapIdToText = snapshotDoc.getMap<Y.Text>("idToText");
	const snapMeta = snapshotDoc.getMap<FileMeta>("meta");
	const snapPathToBlob = snapshotDoc.getMap<BlobRef>("pathToBlob");

	const livePathToId = liveDoc.getMap<string>("pathToId");
	const liveIdToText = liveDoc.getMap<Y.Text>("idToText");
	const livePathToBlob = liveDoc.getMap<BlobRef>("pathToBlob");

	const diff: SnapshotDiff = {
		deletedSinceSnapshot: [],
		createdSinceSnapshot: [],
		contentChanged: [],
		unchanged: [],
		blobsDeletedSinceSnapshot: [],
		blobsCreatedSinceSnapshot: [],
		blobsChanged: [],
	};

	// Collect snapshot paths (non-tombstoned)
	const snapshotPaths = new Map<string, string>(); // path -> fileId
	snapPathToId.forEach((fileId, path) => {
		const meta = snapMeta.get(fileId);
		if (meta?.deleted) return; // skip tombstoned
		snapshotPaths.set(path, fileId);
	});

	// Collect live paths
	const livePaths = new Set<string>();
	livePathToId.forEach((_id, path) => {
		livePaths.add(path);
	});

	// Markdown diff
	for (const [path, snapFileId] of snapshotPaths) {
		const liveFileId = livePathToId.get(path);
		if (!liveFileId) {
			// Deleted since snapshot
			diff.deletedSinceSnapshot.push({ path, fileId: snapFileId });
			continue;
		}

		const snapText = snapIdToText.get(snapFileId);
		const liveText = liveIdToText.get(liveFileId);
		const snapContent = snapText?.toString() ?? "";
		const liveContent = liveText?.toString() ?? "";

		if (snapContent === liveContent) {
			diff.unchanged.push(path);
		} else {
			diff.contentChanged.push({
				path,
				fileId: snapFileId,
				snapshotContent: snapContent,
				currentContent: liveContent,
			});
		}
	}

	// Files created since snapshot
	for (const path of livePaths) {
		if (!snapshotPaths.has(path)) {
			diff.createdSinceSnapshot.push(path);
		}
	}

	// Blob diff
	const snapshotBlobs = new Map<string, string>(); // path -> hash
	snapPathToBlob.forEach((ref, path) => {
		snapshotBlobs.set(path, ref.hash);
	});

	const liveBlobs = new Map<string, string>();
	livePathToBlob.forEach((ref, path) => {
		liveBlobs.set(path, ref.hash);
	});

	for (const [path, snapHash] of snapshotBlobs) {
		const liveHash = liveBlobs.get(path);
		if (!liveHash) {
			diff.blobsDeletedSinceSnapshot.push({ path, hash: snapHash });
		} else if (liveHash !== snapHash) {
			diff.blobsChanged.push({ path, snapshotHash: snapHash, currentHash: liveHash });
		}
	}

	for (const path of liveBlobs.keys()) {
		if (!snapshotBlobs.has(path)) {
			diff.blobsCreatedSinceSnapshot.push(path);
		}
	}

	return diff;
}

// -------------------------------------------------------------------
// Restore
// -------------------------------------------------------------------

/** Origin for restore transactions, so disk mirror and other observers can identify them. */
export const ORIGIN_RESTORE = "snapshot-restore";

export interface RestoreOptions {
	/** Paths of markdown files to restore from the snapshot. */
	markdownPaths?: string[];
	/** Paths of blob files to restore from the snapshot (re-point pathToBlob). */
	blobPaths?: string[];
	/** Device name for metadata. */
	device?: string;
}

export interface RestoreResult {
	/** Number of markdown files restored (content replaced). */
	markdownRestored: number;
	/** Number of markdown files undeleted (re-added from tombstone). */
	markdownUndeleted: number;
	/** Number of blob references restored. */
	blobsRestored: number;
}

/**
 * Soft restore: apply snapshot content to the live Y.Doc for selected files.
 *
 * For markdown: replaces the Y.Text content with snapshot content.
 * For blobs: re-points pathToBlob to the snapshot's hash.
 *
 * This is a "soft" restore — it operates within the existing CRDT, so
 * changes propagate to all connected devices. If another device has
 * concurrent edits, Yjs will merge them.
 */
export function restoreFromSnapshot(
	snapshotDoc: Y.Doc,
	liveDoc: Y.Doc,
	options: RestoreOptions,
): RestoreResult {
	const snapPathToId = snapshotDoc.getMap<string>("pathToId");
	const snapIdToText = snapshotDoc.getMap<Y.Text>("idToText");
	const snapMeta = snapshotDoc.getMap<FileMeta>("meta");
	const snapPathToBlob = snapshotDoc.getMap<BlobRef>("pathToBlob");

	const livePathToId = liveDoc.getMap<string>("pathToId");
	const liveIdToText = liveDoc.getMap<Y.Text>("idToText");
	const liveMeta = liveDoc.getMap<FileMeta>("meta");
	const livePathToBlob = liveDoc.getMap<BlobRef>("pathToBlob");
	const liveBlobTombstones = liveDoc.getMap("blobTombstones");

	const result: RestoreResult = {
		markdownRestored: 0,
		markdownUndeleted: 0,
		blobsRestored: 0,
	};

	liveDoc.transact(() => {
		// Restore markdown files
		for (const path of options.markdownPaths ?? []) {
			const snapFileId = snapPathToId.get(path);
			if (!snapFileId) continue;

			const snapText = snapIdToText.get(snapFileId);
			if (!snapText) continue;
			const snapContent = snapText.toString();

			const liveFileId = livePathToId.get(path);

			if (liveFileId) {
				// File still exists in live — replace content
				const liveText = liveIdToText.get(liveFileId);
				if (liveText) {
					const currentContent = liveText.toString();
					if (currentContent !== snapContent) {
						liveText.delete(0, liveText.length);
						liveText.insert(0, snapContent);
						result.markdownRestored++;

						// Update metadata
						liveMeta.set(liveFileId, {
							path,
							mtime: Date.now(),
							device: options.device,
						});
					}
				}
			} else {
				// File was deleted since snapshot — undelete
				// Re-create with the snapshot's file ID and content
				livePathToId.set(path, snapFileId);

				// Check if the Y.Text still exists (tombstoning doesn't delete it)
				let liveText = liveIdToText.get(snapFileId);
				if (liveText) {
					// Clear and replace content
					if (liveText.length > 0) {
						liveText.delete(0, liveText.length);
					}
					liveText.insert(0, snapContent);
				} else {
					// Create a new Y.Text with the snapshot content
					liveText = new Y.Text();
					liveText.insert(0, snapContent);
					liveIdToText.set(snapFileId, liveText);
				}

				// Clear tombstone and set fresh metadata
				liveMeta.set(snapFileId, {
					path,
					mtime: Date.now(),
					device: options.device,
				});

				result.markdownUndeleted++;
			}
		}

		// Restore blob references
		for (const path of options.blobPaths ?? []) {
			const snapRef = snapPathToBlob.get(path);
			if (!snapRef) continue;

			livePathToBlob.set(path, snapRef);

			// Clear any tombstone at this path
			if (liveBlobTombstones.has(path)) {
				liveBlobTombstones.delete(path);
			}

			result.blobsRestored++;
		}
	}, ORIGIN_RESTORE);

	return result;
}
