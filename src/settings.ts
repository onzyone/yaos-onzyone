import { App, Modal, Notice, PluginSettingTab, Setting } from "obsidian";
import type VaultCrdtSyncPlugin from "./main";
import { randomBase64Url } from "./utils/base64url";

/** Controls how external disk edits (git, other editors) are imported into CRDT. */
export type ExternalEditPolicy = "always" | "closed-only" | "never";

export interface VaultSyncSettings {
	/** Cloudflare Worker host, e.g. "https://sync.yourdomain.com" */
	host: string;
	/** Shared secret token for auth. */
	token: string;
	/** Unique vault identifier. Generated randomly if empty on first load. */
	vaultId: string;
	/** Human-readable device name shown in awareness/cursors. */
	deviceName: string;
	/** Enable verbose console.log output for debugging. */
	debug: boolean;
	/** Comma-separated path prefixes to exclude from sync. */
	excludePatterns: string;
	/** Maximum file size in KB to sync via CRDT. Files larger are skipped. */
	maxFileSizeKB: number;
	/**
	 * How to handle external disk modifications (git pull, other editors).
	 *   "always"      — always import into CRDT (default, current behavior)
	 *   "closed-only" — import only for files not open in an editor
	 *   "never"       — never import (CRDT is sole source of truth)
	 */
	externalEditPolicy: ExternalEditPolicy;

	// ---------------------------------------------------------------
	// Attachment sync (R2 blob store)
	// ---------------------------------------------------------------

	/** Enable attachment (non-markdown) sync via R2 blob store. */
	enableAttachmentSync: boolean;
	/** True once the user has explicitly changed the attachment sync toggle. */
	attachmentSyncExplicitlyConfigured: boolean;
	/** Maximum attachment size in KB. Files larger are skipped. Default 10240 (10 MB). */
	maxAttachmentSizeKB: number;
	/** Number of parallel upload/download slots. */
	attachmentConcurrency: number;

	// ---------------------------------------------------------------
	// Collaboration display
	// ---------------------------------------------------------------

	/** Show remote cursors and selections in the editor. */
	showRemoteCursors: boolean;
}

export const DEFAULT_SETTINGS: VaultSyncSettings = {
	host: "",
	token: "",
	vaultId: "",
	deviceName: "",
	debug: false,
	excludePatterns: "",
	maxFileSizeKB: 2048,
	externalEditPolicy: "always",
	enableAttachmentSync: true,
	attachmentSyncExplicitlyConfigured: false,
	maxAttachmentSizeKB: 10240,
	// requestUrl cannot be hard-aborted; default to 1 to avoid stacked zombie transfers.
	attachmentConcurrency: 1,
	showRemoteCursors: true,
};

const CLOUDFLARE_DEPLOY_URL = "https://deploy.workers.cloudflare.com/?url=https://github.com/kavinsood/yaos/tree/main/server";

/** Generate a random vault ID (16 bytes, base64url). */
export function generateVaultId(): string {
	return randomBase64Url(16);
}

/** Returns true if the host URL is unencrypted and not localhost. */
function isInsecureRemoteHost(host: string): boolean {
	if (!host) return false;
	try {
		const url = new URL(host);
		if (url.protocol !== "http:") return false;
		const h = url.hostname;
		if (h === "localhost" || h === "127.0.0.1" || h === "[::1]") return false;
		return true;
	} catch {
		return false;
	}
}

class PairDeviceModal extends Modal {
	constructor(
		app: App,
		private readonly deepLink: string,
		private readonly mobileUrl: string,
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();

		contentEl.createEl("h3", { text: "Pair new device" });
		contentEl.createEl("p", {
			text: "Use the mobile setup URL on your phone, or copy the deep link directly on desktop.",
		});

		contentEl.createEl("h4", { text: "Mobile setup URL" });
		const mobileInput = contentEl.createEl("textarea");
		mobileInput.value = this.mobileUrl;
		mobileInput.readOnly = true;
		mobileInput.rows = 3;
		mobileInput.style.width = "100%";
		mobileInput.style.marginBottom = "8px";

		const mobileButtons = contentEl.createDiv({ cls: "modal-button-container" });
		mobileButtons.createEl("button", { text: "Copy mobile URL" }).addEventListener("click", () => {
			void navigator.clipboard.writeText(this.mobileUrl).then(
				() => new Notice("YAOS: mobile setup URL copied."),
				() => new Notice("YAOS: failed to copy mobile setup URL.", 6000),
			);
		});
		mobileButtons.createEl("button", { text: "Open mobile setup page" }).addEventListener("click", () => {
			window.open(this.mobileUrl, "_blank", "noopener");
		});

		contentEl.createEl("h4", { text: "Deep link" });
		const deepInput = contentEl.createEl("textarea");
		deepInput.value = this.deepLink;
		deepInput.readOnly = true;
		deepInput.rows = 3;
		deepInput.style.width = "100%";
		deepInput.style.marginBottom = "8px";

		const deepButtons = contentEl.createDiv({ cls: "modal-button-container" });
		deepButtons.createEl("button", { text: "Copy deep link" }).addEventListener("click", () => {
			void navigator.clipboard.writeText(this.deepLink).then(
				() => new Notice("YAOS: deep link copied."),
				() => new Notice("YAOS: failed to copy deep link.", 6000),
			);
		});
		deepButtons.createEl("button", { text: "Close" }).addEventListener("click", () => this.close());
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

class RecoveryKitModal extends Modal {
	constructor(app: App, private readonly recoveryKit: string) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();

		contentEl.createEl("h3", { text: "Recovery kit" });
		contentEl.createEl("p", {
			text: "Save this in your password manager. You need host, token, and vault ID to recover this room on a new device.",
		});

		const textArea = contentEl.createEl("textarea");
		textArea.value = this.recoveryKit;
		textArea.readOnly = true;
		textArea.rows = 10;
		textArea.style.width = "100%";
		textArea.style.marginBottom = "8px";

		const buttons = contentEl.createDiv({ cls: "modal-button-container" });
		buttons.createEl("button", { text: "Copy recovery kit" }).addEventListener("click", () => {
			void navigator.clipboard.writeText(this.recoveryKit).then(
				() => new Notice("YAOS: recovery kit copied."),
				() => new Notice("YAOS: failed to copy recovery kit.", 6000),
			);
		});
		buttons.createEl("button", { text: "Close" }).addEventListener("click", () => this.close());
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

export class VaultSyncSettingTab extends PluginSettingTab {
	plugin: VaultCrdtSyncPlugin;

	constructor(app: App, plugin: VaultCrdtSyncPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		const authMode = this.plugin.serverAuthMode;
		const attachmentsAvailable = this.plugin.serverSupportsAttachments;
		const setupIncomplete = !this.plugin.settings.host || !this.plugin.settings.token;

		containerEl.createEl("h2", { text: "YAOS" });

		if (setupIncomplete) {
			const callout = containerEl.createDiv({ cls: "callout" });
			callout.setAttr("data-callout", "warning");
			callout.style.marginBottom = "16px";

			const calloutTitle = callout.createDiv({ cls: "callout-title" });
			calloutTitle.createSpan({ text: "Setup required" });

			const calloutContent = callout.createDiv({ cls: "callout-content" });
			calloutContent.createEl("p", {
				text: "YAOS requires a free Cloudflare Worker to sync your data. It costs $0 and takes about 15 seconds.",
			});

			const hint = calloutContent.createEl("p", {
				text: "After deploy, open your Worker URL, claim the server, then run the YAOS setup link.",
			});
			hint.style.marginTop = "-4px";

			new Setting(calloutContent)
				.setName("Deploy your server")
				.setDesc("Launch one-click Cloudflare deployment in your browser.")
				.addButton((button) =>
					button
						.setButtonText("Deploy to Cloudflare")
						.setCta()
						.onClick(() => {
							window.open(CLOUDFLARE_DEPLOY_URL, "_blank", "noopener");
						}),
				);
		}

		new Setting(containerEl)
			.setName("Server host")
			.setDesc(
				"Cloudflare Worker sync URL (e.g. https://sync.yourdomain.com or http://127.0.0.1:8787 for local dev).",
			)
			.addText((text) =>
				text
					.setPlaceholder("https://...")
					.setValue(this.plugin.settings.host)
					.onChange(async (value) => {
						this.plugin.settings.host = value.trim();
						await this.plugin.saveSettings();
						// Re-render to update the warning
						this.display();
					}),
			);

		// WSS/HTTPS warning for non-localhost HTTP connections
		if (isInsecureRemoteHost(this.plugin.settings.host)) {
			const warning = containerEl.createEl("p", {
				text: "Warning: using unencrypted connection. Your sync token will be sent in plaintext. Use https:// for production.",
			});
			warning.style.color = "var(--text-error)";
			warning.style.fontSize = "12px";
			warning.style.marginTop = "-8px";
		}

		new Setting(containerEl)
			.setName("Token")
			.setDesc(
				authMode === "unclaimed"
					? "Leave this blank until you claim the server in a browser, then use the YAOS setup link."
					: authMode === "env"
						? "Shared secret token. Must match the SYNC_TOKEN configured on the server."
						: "Shared secret token. Usually filled automatically by the YAOS setup link after claiming the server.",
			)
			.addText((text) =>
				text
					.setPlaceholder("your-secret-token")
					.setValue(this.plugin.settings.token)
					.onChange(async (value) => {
						this.plugin.settings.token = value.trim();
						await this.plugin.saveSettings();
					}),
			);

			containerEl.createEl("h3", { text: "Pairing" });

			new Setting(containerEl)
				.setName("Pair new device")
				.setDesc(
					"Generate pairing links with host, token, and vault ID from this vault.",
				)
				.addButton((button) =>
					button
						.setButtonText("Show pairing links")
						.setCta()
						.setDisabled(!this.plugin.buildSetupDeepLink())
						.onClick(() => {
							const deepLink = this.plugin.buildSetupDeepLink();
							const mobileUrl = this.plugin.buildMobileSetupUrl();
							if (!deepLink || !mobileUrl) {
								new Notice("YAOS: configure host, token, and vault ID before pairing.", 7000);
								return;
							}
							new PairDeviceModal(this.app, deepLink, mobileUrl).open();
						}),
				);

			new Setting(containerEl)
				.setName("Export recovery kit")
				.setDesc(
					"Export host, token, and vault ID so you can recover this room on a new device.",
				)
				.addButton((button) =>
					button
						.setButtonText("Show recovery kit")
						.setDisabled(!this.plugin.buildRecoveryKitText())
						.onClick(() => {
							const recoveryKit = this.plugin.buildRecoveryKitText();
							if (!recoveryKit) {
								new Notice("YAOS: configure host, token, and vault ID before exporting recovery kit.", 7000);
								return;
							}
							new RecoveryKitModal(this.app, recoveryKit).open();
						}),
				);

		new Setting(containerEl)
			.setName("Device name")
			.setDesc(
				"Name shown to other connected devices (e.g. in remote cursors).",
			)
			.addText((text) =>
				text
					.setPlaceholder("My laptop")
					.setValue(this.plugin.settings.deviceName)
					.onChange(async (value) => {
						this.plugin.settings.deviceName = value.trim();
						await this.plugin.saveSettings();
					}),
			);

		containerEl.createEl("h3", { text: "Filters" });

		new Setting(containerEl)
			.setName("Exclude patterns")
			.setDesc(
				"Comma-separated path prefixes to exclude from sync. Example: templates/, daily-notes/, .trash/",
			)
			.addText((text) =>
				text
					.setPlaceholder("templates/, .trash/")
					.setValue(this.plugin.settings.excludePatterns)
					.onChange(async (value) => {
						this.plugin.settings.excludePatterns = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Max file size (KB)")
			.setDesc(
				"Files larger than this are skipped for CRDT sync. Default 2048 (2 MB). CRDT overhead on very large texts is significant.",
			)
			.addText((text) =>
				text
					.setPlaceholder("2048")
					.setValue(String(this.plugin.settings.maxFileSizeKB))
					.onChange(async (value) => {
						const n = parseInt(value, 10);
						if (!isNaN(n) && n > 0) {
							this.plugin.settings.maxFileSizeKB = n;
							await this.plugin.saveSettings();
						}
					}),
			);

		containerEl.createEl("h3", { text: "Attachment sync" });

		if (this.plugin.settings.host) {
			new Setting(containerEl)
				.setName("R2 backend")
				.setDesc(
					attachmentsAvailable
						? "Available on this server. The Worker detected an R2 bucket binding and can sync attachments plus snapshots."
						: "Unavailable on this server. Add an R2 binding named YAOS_BUCKET in Cloudflare, then redeploy to enable attachments plus snapshots.",
				)
				.addButton((button) =>
					button
						.setButtonText("Refresh")
						.onClick(async () => {
							button.setDisabled(true);
							await this.plugin.refreshServerCapabilities();
							await this.plugin.refreshAttachmentSyncRuntime("capability-refresh");
							this.display();
						}),
				);
		}

		if (this.plugin.settings.host && !attachmentsAvailable) {
			const note = containerEl.createEl("p", {
				text:
					"Attachment sync is unavailable on this server. Add an R2 binding named YAOS_BUCKET in Cloudflare to enable attachments and snapshots.",
			});
			note.style.color = "var(--text-muted)";
			note.style.fontSize = "12px";
			note.style.marginTop = "-8px";
		}

		if (attachmentsAvailable || !this.plugin.settings.host) {
			new Setting(containerEl)
				.setName("Sync attachments")
				.setDesc(
					"Sync non-markdown files (images, PDFs, etc.) via R2 object storage. " +
					"Requires R2 configuration on the server. Markdown notes always sync via CRDT.",
				)
				.addToggle((toggle) =>
					toggle
						.setValue(this.plugin.settings.enableAttachmentSync)
						.onChange(async (value) => {
							this.plugin.settings.enableAttachmentSync = value;
							await this.plugin.saveSettings();
							await this.plugin.refreshAttachmentSyncRuntime("attachment-toggle");
							this.display();
						}),
				);
		}

		if ((attachmentsAvailable || !this.plugin.settings.host) && this.plugin.settings.enableAttachmentSync) {
			new Setting(containerEl)
				.setName("Max attachment size (KB)")
				.setDesc(
					"Attachments larger than this are skipped. Default 10240 (10 MB).",
				)
				.addText((text) =>
					text
						.setPlaceholder("10240")
						.setValue(String(this.plugin.settings.maxAttachmentSizeKB))
						.onChange(async (value) => {
							const n = parseInt(value, 10);
							if (!isNaN(n) && n > 0) {
								this.plugin.settings.maxAttachmentSizeKB = n;
								await this.plugin.saveSettings();
							}
						}),
				);

			new Setting(containerEl)
				.setName("Concurrent transfers")
				.setDesc(
					"Number of parallel upload/download slots (1-5). Default 1 favors reliability on slow/mobile networks.",
				)
				.addSlider((slider) =>
					slider
						.setLimits(1, 5, 1)
						.setValue(this.plugin.settings.attachmentConcurrency)
						.setDynamicTooltip()
						.onChange(async (value) => {
							this.plugin.settings.attachmentConcurrency = value;
							await this.plugin.saveSettings();
						}),
				);
		}

			containerEl.createEl("h3", { text: "Advanced" });

			const vaultIdentityDetails = containerEl.createEl("details");
			const vaultIdentitySummary = vaultIdentityDetails.createEl("summary", {
				text: "Vault identity (advanced)",
			});
			vaultIdentitySummary.style.cursor = "pointer";
			const vaultIdentityBody = vaultIdentityDetails.createDiv();
			vaultIdentityBody.style.marginTop = "8px";

			new Setting(vaultIdentityBody)
				.setName("Vault ID")
				.setDesc(
					"Manual override. Devices syncing the same vault must use exactly the same Vault ID.",
				)
				.addText((text) =>
					text
						.setPlaceholder("auto-generated")
						.setValue(this.plugin.settings.vaultId)
						.onChange(async (value) => {
							this.plugin.settings.vaultId = value.trim();
							await this.plugin.saveSettings();
						}),
				);

			new Setting(containerEl)
				.setName("Show remote cursors")
			.setDesc(
				"Display cursors and selections from other connected devices in the editor.",
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.showRemoteCursors)
					.onChange(async (value) => {
						this.plugin.settings.showRemoteCursors = value;
						await this.plugin.saveSettings();
						this.plugin.applyCursorVisibility();
					}),
			);

		new Setting(containerEl)
			.setName("External edit policy")
			.setDesc(
				"How to handle disk changes from external tools (git, other editors). " +
				"\"Always\" imports all changes into CRDT. \"Only when closed\" skips files open in an editor. " +
				"\"Never\" ignores external edits entirely.",
			)
			.addDropdown((dropdown) =>
				dropdown
					.addOption("always", "Always import")
					.addOption("closed-only", "Only when closed")
					.addOption("never", "Never import")
					.setValue(this.plugin.settings.externalEditPolicy)
					.onChange(async (value) => {
						this.plugin.settings.externalEditPolicy = value as ExternalEditPolicy;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Debug logging")
			.setDesc("Enable verbose console logging for troubleshooting.")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.debug).onChange(async (value) => {
					this.plugin.settings.debug = value;
					await this.plugin.saveSettings();
				}),
			);

		containerEl.createEl("p", {
			text: "Changes to host, token, or vault ID require reloading the plugin (disable then re-enable, or restart Obsidian).",
			cls: "setting-item-description",
		});
	}
}
