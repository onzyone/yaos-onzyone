import { execFileSync } from "node:child_process";
import {
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const defaultReleaseRepo = "kavinsood/yaos";
const releaseRepo = process.env.YAOS_RELEASE_REPO?.trim() || defaultReleaseRepo;
const releaseVersion = process.env.YAOS_RELEASE_VERSION?.trim() ?? "";
const explicitArtifactInput =
	process.env.YAOS_RELEASE_FILE?.trim() ?? process.env.YAOS_RELEASE_URL?.trim() ?? "";
const artifactSource = explicitArtifactInput
	? resolveArtifactSource(explicitArtifactInput)
	: releaseVersion
		? {
				type: "remote",
				label: `GitHub release ${releaseRepo}@${releaseVersion}`,
				value: `https://github.com/${releaseRepo}/releases/download/${releaseVersion}/yaos-server.zip`,
			}
		: {
				type: "remote",
				label: `latest GitHub release from ${releaseRepo}`,
				value: `https://github.com/${releaseRepo}/releases/latest/download/yaos-server.zip`,
			};

const repoRoot = resolve(".");
const tempDir = mkdtempSync(join(tmpdir(), "yaos-server-update-"));
const zipPath = join(tempDir, "yaos-server.zip");
const extractDir = join(tempDir, "extract");

function resolveArtifactSource(input) {
	if (/^https?:\/\//i.test(input)) {
		return { type: "remote", label: input, value: input };
	}

	const normalizedPath = input.startsWith("file://") ? new URL(input) : resolve(input);
	const filePath = normalizedPath instanceof URL ? normalizedPath : normalizedPath;
	if (!existsSync(filePath)) {
		throw new Error(`Local YAOS server artifact was not found: ${filePath}`);
	}
	return { type: "local", label: String(filePath), value: String(filePath) };
}

async function stageArtifactZip() {
	if (artifactSource.type === "local") {
		console.log(`Using local YAOS server artifact from ${artifactSource.label}`);
		cpSync(artifactSource.value, zipPath);
		return;
	}

	console.log(`Downloading YAOS server artifact from ${artifactSource.label}`);
	const response = await fetch(artifactSource.value, {
		redirect: "follow",
		headers: {
			"User-Agent": "yaos-server-updater",
		},
	});
	if (!response.ok) {
		throw new Error(`Download failed (${response.status})`);
	}
	writeFileSync(zipPath, Buffer.from(await response.arrayBuffer()));
}

async function main() {
	await stageArtifactZip();
	mkdirSync(extractDir, { recursive: true });
	execFileSync("unzip", ["-q", zipPath, "-d", extractDir], { stdio: "inherit" });

	const manifestPath = join(extractDir, "yaos-server-manifest.json");
	const rawManifest = JSON.parse(readFileSync(manifestPath, "utf8"));
	if (!Array.isArray(rawManifest.updateOwnedPaths)) {
		throw new Error("Artifact manifest is missing updateOwnedPaths");
	}

	for (const relativePath of rawManifest.updateOwnedPaths) {
		if (typeof relativePath !== "string" || !relativePath) {
			throw new Error(`Invalid update-owned path in artifact: ${String(relativePath)}`);
		}
		const sourcePath = join(extractDir, relativePath);
		const targetPath = join(repoRoot, relativePath);
		rmSync(targetPath, { recursive: true, force: true });
		const sourceStats = statSync(sourcePath);
		if (sourceStats.isDirectory()) {
			cpSync(sourcePath, targetPath, { recursive: true });
		} else {
			mkdirSync(dirname(targetPath), { recursive: true });
			cpSync(sourcePath, targetPath);
		}
		console.log(`Updated ${relativePath}`);
	}

	console.log(
		`Applied YAOS server artifact${rawManifest.serverVersion ? ` ${rawManifest.serverVersion}` : ""}`,
	);
}

await main().finally(() => {
	rmSync(tempDir, { recursive: true, force: true });
});
