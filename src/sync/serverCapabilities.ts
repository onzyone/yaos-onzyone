import { obsidianRequest } from "../utils/http";

export interface ServerCapabilities {
	claimed: boolean;
	authMode: "env" | "claim" | "unclaimed";
	attachments: boolean;
	snapshots: boolean;
}

export async function fetchServerCapabilities(host: string): Promise<ServerCapabilities> {
	const base = host.replace(/\/$/, "");
	const res = await obsidianRequest({
		url: `${base}/api/capabilities`,
		method: "GET",
	});
	if (res.status !== 200) {
		throw new Error(`capabilities request failed (${res.status})`);
	}
	return res.json as ServerCapabilities;
}
