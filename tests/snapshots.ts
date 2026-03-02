/**
 * CLI test script for snapshot infrastructure.
 *
 * Category 1: Pure CRDT logic (no server needed)
 *   - Snapshot encode → gzip → gunzip → decode round-trip
 *   - Diff between snapshot and modified doc
 *   - Soft restore (content replace + undelete + blob re-point)
 *
 * Category 2: Live server endpoints (needs SYNC_TOKEN + R2)
 *   - Auth rejection
 *   - /snapshot/now, /snapshot/maybe, /snapshot/list, /snapshot/presign-get
 *   - Download actual snapshot from R2
 *   - /blob/presign-put, /blob/exists, /blob/presign-get
 *
 * Usage:
 *   npx tsx test-snapshots.ts
 *
 * Reads server/.env for SYNC_TOKEN and R2 config.
 * Uses a dedicated test vault ID to avoid touching real data.
 */

import * as Y from "yjs";
import { gzipSync, gunzipSync } from "fflate";
import { readFileSync } from "fs";
import { resolve } from "path";

// -------------------------------------------------------------------
// Config
// -------------------------------------------------------------------

// Parse server/.env
const envPath = resolve(new URL(".", import.meta.url).pathname, "../server/.env");
let envVars: Record<string, string> = {};
try {
	const envContent = readFileSync(envPath, "utf-8");
	for (const line of envContent.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;
		const eq = trimmed.indexOf("=");
		if (eq > 0) {
			envVars[trimmed.slice(0, eq)] = trimmed.slice(eq + 1);
		}
	}
} catch {
	console.warn("Could not read server/.env — Category 2 tests will be skipped.");
}

const HOST = "https://sync.tenetstack.com";
const TOKEN = envVars.SYNC_TOKEN ?? "";
const TEST_VAULT_ID = `cli-test-${Date.now().toString(36)}`;
const ROOM_ID = `v1:${TEST_VAULT_ID}`;

function baseUrl(): string {
	return `${HOST}/parties/main/${encodeURIComponent(ROOM_ID)}`;
}

// -------------------------------------------------------------------
// Test helpers
// -------------------------------------------------------------------

let passed = 0;
let failed = 0;

function assert(condition: boolean, msg: string): void {
	if (condition) {
		console.log(`  ✓ ${msg}`);
		passed++;
	} else {
		console.error(`  ✗ FAIL: ${msg}`);
		failed++;
	}
}

function assertEqual(actual: unknown, expected: unknown, msg: string): void {
	if (actual === expected) {
		console.log(`  ✓ ${msg}`);
		passed++;
	} else {
		console.error(`  ✗ FAIL: ${msg} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
		failed++;
	}
}

// -------------------------------------------------------------------
// Category 1: Pure CRDT logic
// -------------------------------------------------------------------

function createTestDoc(): Y.Doc {
	const doc = new Y.Doc();
	const pathToId = doc.getMap<string>("pathToId");
	const idToText = doc.getMap<Y.Text>("idToText");
	const meta = doc.getMap("meta");
	const sys = doc.getMap("sys");
	const pathToBlob = doc.getMap("pathToBlob");
	const blobMeta = doc.getMap("blobMeta");

	doc.transact(() => {
		// Markdown files
		for (const [path, content] of [
			["notes/hello.md", "# Hello\nThis is a test note."],
			["notes/world.md", "# World\nAnother note."],
			["notes/deep/nested.md", "# Nested\nDeep file."],
		] as const) {
			const id = `id-${path.replace(/[^a-z]/g, "-")}`;
			const text = new Y.Text();
			text.insert(0, content);
			pathToId.set(path, id);
			idToText.set(id, text);
			meta.set(id, { path, mtime: Date.now() });
		}

		// Blob files
		pathToBlob.set("images/test.png", { hash: "a".repeat(64), size: 1024 });
		pathToBlob.set("attachments/doc.pdf", { hash: "b".repeat(64), size: 2048 });
		blobMeta.set("a".repeat(64), { size: 1024, mime: "image/png", createdAt: Date.now() });
		blobMeta.set("b".repeat(64), { size: 2048, mime: "application/pdf", createdAt: Date.now() });

		// System metadata
		sys.set("initialized", true);
		sys.set("schemaVersion", 1);
	});

	return doc;
}

async function testCategory1(): Promise<void> {
	console.log("\n═══════════════════════════════════════════════");
	console.log("CATEGORY 1: Pure CRDT snapshot/diff/restore");
	console.log("═══════════════════════════════════════════════\n");

	// --- Test 1: Round-trip encode/decode ---
	console.log("--- Test 1: Snapshot encode → gzip → gunzip → decode ---");
	{
		const doc = createTestDoc();
		const rawUpdate = Y.encodeStateAsUpdate(doc);
		const compressed = gzipSync(rawUpdate);
		const decompressed = gunzipSync(compressed);
		const restored = new Y.Doc();
		Y.applyUpdate(restored, decompressed);

		const origPaths = doc.getMap<string>("pathToId");
		const restoredPaths = restored.getMap<string>("pathToId");

		assertEqual(restoredPaths.size, origPaths.size, `pathToId size matches (${origPaths.size})`);

		for (const [path, id] of origPaths.entries()) {
			assertEqual(restoredPaths.get(path), id, `pathToId["${path}"] preserved`);
		}

		const origTexts = doc.getMap<Y.Text>("idToText");
		const restoredTexts = restored.getMap<Y.Text>("idToText");
		for (const [id, text] of origTexts.entries()) {
			const restoredText = restoredTexts.get(id);
			assertEqual(restoredText?.toString(), text.toString(), `idToText["${id}"] content matches`);
		}

		const origBlobs = doc.getMap("pathToBlob");
		const restoredBlobs = restored.getMap("pathToBlob");
		assertEqual(restoredBlobs.size, origBlobs.size, `pathToBlob size matches (${origBlobs.size})`);

		assert(compressed.byteLength < rawUpdate.byteLength, `gzip compressed (${rawUpdate.byteLength} → ${compressed.byteLength} bytes)`);

		const sys = restored.getMap("sys");
		assertEqual(sys.get("schemaVersion"), 1, "schemaVersion preserved");
		assertEqual(sys.get("initialized"), true, "initialized flag preserved");

		doc.destroy();
		restored.destroy();
	}

	// --- Test 2: Diff ---
	console.log("\n--- Test 2: Diff between snapshot and modified doc ---");
	{
		const original = createTestDoc();
		const snapshotUpdate = Y.encodeStateAsUpdate(original);

		// Create snapshot doc
		const snapshotDoc = new Y.Doc();
		Y.applyUpdate(snapshotDoc, snapshotUpdate);

		// Now modify the original (simulating "time passes, edits happen")
		const pathToId = original.getMap<string>("pathToId");
		const idToText = original.getMap<Y.Text>("idToText");
		const meta = original.getMap("meta");
		const pathToBlob = original.getMap("pathToBlob");

		original.transact(() => {
			// 1. Edit hello.md content
			const helloId = pathToId.get("notes/hello.md")!;
			const helloText = idToText.get(helloId)!;
			helloText.delete(0, helloText.length);
			helloText.insert(0, "# Hello MODIFIED\nChanged content.");

			// 2. Delete world.md (tombstone)
			const worldId = pathToId.get("notes/world.md")!;
			pathToId.delete("notes/world.md");
			meta.set(worldId, { path: "notes/world.md", deleted: true, mtime: Date.now() });

			// 3. Create a new file
			const newId = "id-new-file";
			const newText = new Y.Text();
			newText.insert(0, "# Brand New\nCreated after snapshot.");
			pathToId.set("notes/new.md", newId);
			idToText.set(newId, newText);
			meta.set(newId, { path: "notes/new.md", mtime: Date.now() });

			// 4. Change a blob hash
			pathToBlob.set("images/test.png", { hash: "c".repeat(64), size: 2048 });

			// 5. Delete a blob
			pathToBlob.delete("attachments/doc.pdf");
		});

		// Now diff
		const snapPTI = snapshotDoc.getMap<string>("pathToId");
		const snapITT = snapshotDoc.getMap<Y.Text>("idToText");
		const snapMeta = snapshotDoc.getMap("meta");
		const snapPTB = snapshotDoc.getMap("pathToBlob");
		const livePTI = original.getMap<string>("pathToId");
		const liveITT = original.getMap<Y.Text>("idToText");
		const livePTB = original.getMap("pathToBlob");

		// Manual diff (same logic as snapshotClient.diffSnapshot)
		const deletedSinceSnapshot: string[] = [];
		const createdSinceSnapshot: string[] = [];
		const contentChanged: string[] = [];
		const unchanged: string[] = [];
		const blobsDeleted: string[] = [];
		const blobsChanged: string[] = [];
		const blobsCreated: string[] = [];

		const snapshotPaths = new Map<string, string>();
		snapPTI.forEach((fileId: string, path: string) => {
			const m = snapMeta.get(fileId) as { deleted?: boolean } | undefined;
			if (m?.deleted) return;
			snapshotPaths.set(path, fileId);
		});

		const livePaths = new Set<string>();
		livePTI.forEach((_id: string, path: string) => livePaths.add(path));

		for (const [path, snapFileId] of snapshotPaths) {
			const liveFileId = livePTI.get(path);
			if (!liveFileId) {
				deletedSinceSnapshot.push(path);
				continue;
			}
			const snapContent = snapITT.get(snapFileId)?.toString() ?? "";
			const liveContent = liveITT.get(liveFileId)?.toString() ?? "";
			if (snapContent === liveContent) {
				unchanged.push(path);
			} else {
				contentChanged.push(path);
			}
		}
		for (const path of livePaths) {
			if (!snapshotPaths.has(path)) createdSinceSnapshot.push(path);
		}

		const snapBlobs = new Map<string, string>();
		snapPTB.forEach((ref: any, path: string) => snapBlobs.set(path, ref.hash));
		const liveBlobs = new Map<string, string>();
		livePTB.forEach((ref: any, path: string) => liveBlobs.set(path, ref.hash));

		for (const [path, snapHash] of snapBlobs) {
			const liveHash = liveBlobs.get(path);
			if (!liveHash) blobsDeleted.push(path);
			else if (liveHash !== snapHash) blobsChanged.push(path);
		}
		for (const path of liveBlobs.keys()) {
			if (!snapBlobs.has(path)) blobsCreated.push(path);
		}

		assertEqual(deletedSinceSnapshot.length, 1, "1 file deleted since snapshot");
		assert(deletedSinceSnapshot.includes("notes/world.md"), "  deleted: notes/world.md");

		assertEqual(createdSinceSnapshot.length, 1, "1 file created since snapshot");
		assert(createdSinceSnapshot.includes("notes/new.md"), "  created: notes/new.md");

		assertEqual(contentChanged.length, 1, "1 file content changed");
		assert(contentChanged.includes("notes/hello.md"), "  changed: notes/hello.md");

		assertEqual(unchanged.length, 1, "1 file unchanged");
		assert(unchanged.includes("notes/deep/nested.md"), "  unchanged: notes/deep/nested.md");

		assertEqual(blobsDeleted.length, 1, "1 blob deleted");
		assert(blobsDeleted.includes("attachments/doc.pdf"), "  deleted blob: attachments/doc.pdf");

		assertEqual(blobsChanged.length, 1, "1 blob changed");
		assert(blobsChanged.includes("images/test.png"), "  changed blob: images/test.png");

		assertEqual(blobsCreated.length, 0, "0 blobs created");

		snapshotDoc.destroy();
		original.destroy();
	}

	// --- Test 3: Soft restore ---
	console.log("\n--- Test 3: Soft restore (content replace + undelete + blob) ---");
	{
		const original = createTestDoc();
		const snapshotUpdate = Y.encodeStateAsUpdate(original);
		const snapshotDoc = new Y.Doc();
		Y.applyUpdate(snapshotDoc, snapshotUpdate);

		// Modify original
		const pathToId = original.getMap<string>("pathToId");
		const idToText = original.getMap<Y.Text>("idToText");
		const meta = original.getMap("meta");
		const pathToBlob = original.getMap("pathToBlob");

		original.transact(() => {
			// Edit hello.md
			const helloId = pathToId.get("notes/hello.md")!;
			const helloText = idToText.get(helloId)!;
			helloText.delete(0, helloText.length);
			helloText.insert(0, "MODIFIED CONTENT");

			// Delete world.md
			const worldId = pathToId.get("notes/world.md")!;
			pathToId.delete("notes/world.md");
			meta.set(worldId, { path: "notes/world.md", deleted: true, mtime: Date.now() });

			// Change blob
			pathToBlob.set("images/test.png", { hash: "x".repeat(64), size: 9999 });
		});

		// Verify pre-restore state
		assertEqual(pathToId.get("notes/world.md"), undefined, "world.md deleted before restore");
		assertEqual(
			idToText.get(pathToId.get("notes/hello.md")!)?.toString(),
			"MODIFIED CONTENT",
			"hello.md has modified content before restore",
		);

		// Now restore hello.md + world.md + test.png from snapshot
		const snapPTI = snapshotDoc.getMap<string>("pathToId");
		const snapITT = snapshotDoc.getMap<Y.Text>("idToText");
		const snapPTB = snapshotDoc.getMap("pathToBlob");

		const ORIGIN_RESTORE = "snapshot-restore";

		original.transact(() => {
			// Restore hello.md (content replace)
			{
				const snapId = snapPTI.get("notes/hello.md")!;
				const snapContent = snapITT.get(snapId)!.toString();
				const liveId = pathToId.get("notes/hello.md")!;
				const liveText = idToText.get(liveId)!;
				liveText.delete(0, liveText.length);
				liveText.insert(0, snapContent);
			}

			// Restore world.md (undelete)
			{
				const snapId = snapPTI.get("notes/world.md")!;
				const snapContent = snapITT.get(snapId)!.toString();
				pathToId.set("notes/world.md", snapId);
				let liveText = idToText.get(snapId);
				if (liveText) {
					if (liveText.length > 0) liveText.delete(0, liveText.length);
					liveText.insert(0, snapContent);
				} else {
					liveText = new Y.Text();
					liveText.insert(0, snapContent);
					idToText.set(snapId, liveText);
				}
				meta.set(snapId, { path: "notes/world.md", mtime: Date.now() });
			}

			// Restore blob
			{
				const snapRef = snapPTB.get("images/test.png") as { hash: string; size: number };
				pathToBlob.set("images/test.png", snapRef);
			}
		}, ORIGIN_RESTORE);

		// Verify post-restore state
		assertEqual(
			idToText.get(pathToId.get("notes/hello.md")!)?.toString(),
			"# Hello\nThis is a test note.",
			"hello.md content restored to snapshot version",
		);

		const worldId = pathToId.get("notes/world.md");
		assert(worldId !== undefined, "world.md undeleted (pathToId entry restored)");
		if (worldId) {
			assertEqual(
				idToText.get(worldId)?.toString(),
				"# World\nAnother note.",
				"world.md content restored",
			);
			const worldMeta = meta.get(worldId) as { deleted?: boolean } | undefined;
			assertEqual(worldMeta?.deleted, undefined, "world.md tombstone cleared");
		}

		const blobRef = pathToBlob.get("images/test.png") as { hash: string; size: number } | undefined;
		assertEqual(blobRef?.hash, "a".repeat(64), "blob hash restored to snapshot version");
		assertEqual(blobRef?.size, 1024, "blob size restored");

		// nested.md should be untouched
		assertEqual(
			idToText.get(pathToId.get("notes/deep/nested.md")!)?.toString(),
			"# Nested\nDeep file.",
			"nested.md untouched by selective restore",
		);

		snapshotDoc.destroy();
		original.destroy();
	}
}

// -------------------------------------------------------------------
// Category 2: Live server endpoints
// -------------------------------------------------------------------

async function serverPost(endpoint: string, body?: Record<string, unknown>): Promise<{ status: number; data: any }> {
	const url = `${baseUrl()}/${endpoint}`;
	const res = await fetch(url, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${TOKEN}`,
		},
		body: body ? JSON.stringify(body) : "{}",
	});
	const data = await res.json().catch(() => null);
	return { status: res.status, data };
}

async function serverGet(endpoint: string): Promise<{ status: number; data: any }> {
	const url = `${baseUrl()}/${endpoint}`;
	const res = await fetch(url, {
		method: "GET",
		headers: {
			Authorization: `Bearer ${TOKEN}`,
		},
	});
	const data = await res.json().catch(() => null);
	return { status: res.status, data };
}

async function testCategory2(): Promise<void> {
	console.log("\n═══════════════════════════════════════════════");
	console.log("CATEGORY 2: Live server endpoints");
	console.log(`  Host: ${HOST}`);
	console.log(`  Room: ${ROOM_ID}`);
	console.log("═══════════════════════════════════════════════\n");

	if (!TOKEN) {
		console.log("  SKIPPED: No SYNC_TOKEN found in server/.env");
		return;
	}

	// --- Test: Auth rejection ---
	console.log("--- Test: Auth rejection ---");
	{
		const badUrl = `${baseUrl()}/snapshot/list`;
		const res = await fetch(badUrl, {
			method: "GET",
			headers: { Authorization: "Bearer wrong-token" },
		});
		assertEqual(res.status, 401, "Wrong token returns 401");

		const noTokenUrl = `${baseUrl()}/snapshot/list`;
		const res2 = await fetch(noTokenUrl, { method: "GET" });
		assertEqual(res2.status, 401, "Missing token returns 401");
	}

	// --- Seed a Y.Doc via WebSocket so the room has data ---
	console.log("\n--- Seeding room with test data via WebSocket ---");
	let wsConnected = false;
	{
		// We need y-partykit/provider which is a browser module.
		// Instead, let's test the HTTP endpoints directly — they work with
		// whatever doc state exists (even empty). The server will create
		// the room on first HTTP request via unstable_getYDoc.
		console.log("  (Using empty room — snapshot will have 0 files, which is valid)");
		wsConnected = true; // Proceed with empty room
	}

	// --- Test: /snapshot/now ---
	console.log("\n--- Test: POST /snapshot/now ---");
	let snapshotId: string | undefined;
	let snapshotDay: string | undefined;
	{
		const { status, data } = await serverPost("snapshot/now", { device: "cli-test" });
		assertEqual(status, 200, "snapshot/now returns 200");
		assertEqual(data?.status, "created", "status is 'created'");
		assert(typeof data?.snapshotId === "string", `snapshotId returned: ${data?.snapshotId}`);
		assert(data?.index !== undefined, "index object returned");
		if (data?.index) {
			assertEqual(data.index.vaultId, TEST_VAULT_ID, `vaultId matches (${TEST_VAULT_ID})`);
			assert(typeof data.index.crdtSizeBytes === "number", `crdtSizeBytes: ${data.index.crdtSizeBytes}`);
			assert(typeof data.index.crdtRawSizeBytes === "number", `crdtRawSizeBytes: ${data.index.crdtRawSizeBytes}`);
			assert(Array.isArray(data.index.referencedBlobHashes), "referencedBlobHashes is array");
			snapshotDay = data.index.day;
		}
		snapshotId = data?.snapshotId;
	}

	// --- Test: /snapshot/maybe (should noop since we just took one) ---
	console.log("\n--- Test: POST /snapshot/maybe (should noop) ---");
	{
		const { status, data } = await serverPost("snapshot/maybe", { device: "cli-test" });
		assertEqual(status, 200, "snapshot/maybe returns 200");
		assertEqual(data?.status, "noop", "status is 'noop' (already taken today)");
		assert(typeof data?.reason === "string", `reason: ${data?.reason}`);
	}

	// --- Test: /snapshot/list ---
	console.log("\n--- Test: GET /snapshot/list ---");
	{
		const { status, data } = await serverGet("snapshot/list");
		assertEqual(status, 200, "snapshot/list returns 200");
		assert(Array.isArray(data?.snapshots), "snapshots is an array");
		assert(data.snapshots.length >= 1, `at least 1 snapshot (got ${data.snapshots.length})`);

		if (data.snapshots.length > 0) {
			const latest = data.snapshots[0];
			assertEqual(latest.snapshotId, snapshotId, "latest snapshot matches what we just created");
			assertEqual(latest.vaultId, TEST_VAULT_ID, "vaultId matches");
		}
	}

	// --- Test: /snapshot/presign-get ---
	console.log("\n--- Test: POST /snapshot/presign-get ---");
	let presignedUrl: string | undefined;
	if (snapshotId && snapshotDay) {
		const { status, data } = await serverPost("snapshot/presign-get", {
			snapshotId,
			day: snapshotDay,
		});
		assertEqual(status, 200, "presign-get returns 200");
		assert(typeof data?.url === "string", "presigned URL returned");
		assert(typeof data?.expiresIn === "number", `expiresIn: ${data?.expiresIn}`);
		presignedUrl = data?.url;
	} else {
		console.log("  SKIPPED: no snapshotId/day from previous test");
	}

	// --- Test: Download actual snapshot from R2 ---
	console.log("\n--- Test: Download snapshot from R2 ---");
	if (presignedUrl) {
		const res = await fetch(presignedUrl);
		assertEqual(res.status, 200, "R2 GET returns 200");
		const compressed = new Uint8Array(await res.arrayBuffer());
		assert(compressed.byteLength > 0, `downloaded ${compressed.byteLength} bytes`);

		try {
			const raw = gunzipSync(compressed);
			assert(raw.byteLength > 0, `decompressed to ${raw.byteLength} bytes`);

			const doc = new Y.Doc();
			Y.applyUpdate(doc, raw);
			assert(true, "Y.applyUpdate succeeded (valid CRDT data)");

			const sys = doc.getMap("sys");
			// Empty room may not have initialized flag, that's OK
			console.log(`  (Doc state: pathToId=${doc.getMap("pathToId").size}, sys.initialized=${sys.get("initialized")})`);
			doc.destroy();
		} catch (err) {
			assert(false, `gunzip + Y.applyUpdate failed: ${err}`);
		}
	} else {
		console.log("  SKIPPED: no presigned URL from previous test");
	}

	// --- Test: Blob endpoints ---
	console.log("\n--- Test: Blob presign-put → upload → exists → presign-get → download ---");
	{
		const testData = new TextEncoder().encode("Hello from CLI test " + Date.now());
		// Compute a fake hash (not real SHA-256, just valid hex for testing)
		const fakeHash = Array.from(testData.slice(0, 32))
			.map((b) => b.toString(16).padStart(2, "0"))
			.join("")
			.padEnd(64, "0");

		// 1. Presign PUT
		const putResult = await serverPost("blob/presign-put", {
			hash: fakeHash,
			contentType: "text/plain",
			contentLength: testData.byteLength,
		});
		assertEqual(putResult.status, 200, "blob/presign-put returns 200");
		assert(typeof putResult.data?.url === "string", "presigned PUT URL returned");

		if (putResult.data?.url) {
			// 2. Actually upload to R2
			const uploadRes = await fetch(putResult.data.url, {
				method: "PUT",
				headers: {
					"Content-Type": "text/plain",
					"Content-Length": String(testData.byteLength),
				},
				body: testData,
			});
			assertEqual(uploadRes.status, 200, `R2 PUT succeeded (${testData.byteLength} bytes)`);

			// 3. Check exists
			const existsResult = await serverPost("blob/exists", {
				hashes: [fakeHash, "0".repeat(64)],
			});
			assertEqual(existsResult.status, 200, "blob/exists returns 200");
			assert(
				Array.isArray(existsResult.data?.present) && existsResult.data.present.includes(fakeHash),
				"uploaded blob found in exists check",
			);
			assert(
				!existsResult.data?.present?.includes("0".repeat(64)),
				"non-existent blob not found (correct)",
			);

			// 4. Presign GET
			const getResult = await serverPost("blob/presign-get", { hash: fakeHash });
			assertEqual(getResult.status, 200, "blob/presign-get returns 200");
			assert(typeof getResult.data?.url === "string", "presigned GET URL returned");

			if (getResult.data?.url) {
				// 5. Download and verify
				const downloadRes = await fetch(getResult.data.url);
				assertEqual(downloadRes.status, 200, "R2 GET returns 200");
				const downloaded = new Uint8Array(await downloadRes.arrayBuffer());
				assertEqual(downloaded.byteLength, testData.byteLength, "downloaded size matches");

				const downloadedStr = new TextDecoder().decode(downloaded);
				const originalStr = new TextDecoder().decode(testData);
				assertEqual(downloadedStr, originalStr, "downloaded content matches uploaded content");
			}
		}
	}

	// --- Test: Bad inputs ---
	console.log("\n--- Test: Input validation ---");
	{
		const r1 = await serverPost("blob/presign-put", { hash: "not-a-hash" });
		assertEqual(r1.status, 400, "invalid hash rejected (presign-put)");

		const r2 = await serverPost("blob/presign-get", { hash: "short" });
		assertEqual(r2.status, 400, "invalid hash rejected (presign-get)");

		const r3 = await serverPost("snapshot/presign-get", { snapshotId: "test" });
		assertEqual(r3.status, 400, "missing day rejected (snapshot/presign-get)");

		const r4 = await serverPost("snapshot/presign-get", { snapshotId: "test", day: "not-a-date" });
		assertEqual(r4.status, 400, "invalid day format rejected");
	}
}

// -------------------------------------------------------------------
// Main
// -------------------------------------------------------------------

async function main(): Promise<void> {
	console.log("╔═══════════════════════════════════════════════╗");
	console.log("║     Snapshot Infrastructure Test Suite        ║");
	console.log("╚═══════════════════════════════════════════════╝");

	await testCategory1();
	await testCategory2();

	console.log("\n═══════════════════════════════════════════════");
	console.log(`RESULTS: ${passed} passed, ${failed} failed`);
	console.log("═══════════════════════════════════════════════");

	if (failed > 0) {
		process.exit(1);
	}
}

main().catch((err) => {
	console.error("Fatal error:", err);
	process.exit(1);
});
