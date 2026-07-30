import { join } from "node:path";
import {
	FileSystemAdapter,
	FileView,
	Notice,
	type TFile,
	type WorkspaceLeaf,
} from "obsidian";
import { inspectHtmlTool } from "./htmltool-signature.js";
import type HtmlToolPlugin from "./main.js";
import { startToolServer, type RunningToolServer } from "./tool-process.js";
import {
	renderError,
	renderPlainHtml,
	renderStatus,
	renderTool,
} from "./view-renderer.js";

export const VIEW_TYPE_HTMLTOOL = "htmltool-view";

export class HtmlToolView extends FileView {
	private runningServer: RunningToolServer | undefined;
	private startupAbort: AbortController | undefined;
	private loadToken = 0;

	constructor(
		leaf: WorkspaceLeaf,
		private readonly plugin: HtmlToolPlugin,
	) {
		super(leaf);
	}

	getViewType(): string {
		return VIEW_TYPE_HTMLTOOL;
	}

	getDisplayText(): string {
		return this.file?.basename ?? "HTML";
	}

	getIcon(): string {
		return "file-code-2";
	}

	async onLoadFile(file: TFile): Promise<void> {
		await super.onLoadFile(file);
		const token = ++this.loadToken;
		this.stopServer();
		renderStatus(this.contentEl, "Inspecting HTML", file.name);

		let source: string;
		try {
			source = await this.app.vault.cachedRead(file);
		} catch (error) {
			renderError(this.contentEl, "Could not read file", errorMessage(error));
			return;
		}
		if (token !== this.loadToken) return;

		const inspection = inspectHtmlTool(source);
		if (inspection.kind === "not-tool") {
			const openButton = renderPlainHtml(this.contentEl, file.name, source);
			this.registerDomEvent(openButton, "click", () => {
				void this.openInDefaultApp(file);
			});
			return;
		}
		if (inspection.kind === "invalid") {
			renderError(
				this.contentEl,
				"Invalid HTMLTool manifest",
				inspection.message,
			);
			return;
		}

		const adapter = this.app.vault.adapter;
		if (!(adapter instanceof FileSystemAdapter)) {
			renderError(
				this.contentEl,
				"Local vault required",
				"HTMLTool can only run files from a desktop filesystem vault.",
			);
			return;
		}

		renderStatus(this.contentEl, "Starting HTMLTool", inspection.name);
		const startupAbort = new AbortController();
		this.startupAbort = startupAbort;
		try {
			const server = await startToolServer({
				executable: this.plugin.settings.executablePath,
				toolPath: adapter.getFullPath(file.path),
				vaultPath: adapter.getBasePath(),
				signal: startupAbort.signal,
				onUnexpectedExit: (message) => {
					if (token !== this.loadToken) return;
					this.runningServer = undefined;
					renderError(this.contentEl, "HTMLTool stopped", message);
				},
			});
			if (token !== this.loadToken) {
				server.stop();
				return;
			}
			this.startupAbort = undefined;
			this.runningServer = server;
			renderTool(this.contentEl, inspection.name, server.url);
		} catch (error) {
			if (token !== this.loadToken) return;
			this.startupAbort = undefined;
			renderError(
				this.contentEl,
				"Could not start HTMLTool",
				errorMessage(error),
			);
		}
	}

	async onUnloadFile(file: TFile): Promise<void> {
		this.loadToken += 1;
		this.stopServer();
		this.contentEl.empty();
		await super.onUnloadFile(file);
	}

	async onClose(): Promise<void> {
		this.loadToken += 1;
		this.stopServer();
		this.contentEl.empty();
	}

	private stopServer(): void {
		this.startupAbort?.abort();
		this.startupAbort = undefined;
		this.runningServer?.stop();
		this.runningServer = undefined;
	}

	private async openInDefaultApp(file: TFile): Promise<void> {
		const adapter = this.app.vault.adapter;
		if (!(adapter instanceof FileSystemAdapter)) {
			new Notice("This file is not stored in a local filesystem vault.");
			return;
		}

		try {
			const { shell } = require("electron") as {
				shell: { openPath(path: string): Promise<string> };
			};
			const message = await shell.openPath(
				join(adapter.getBasePath(), file.path),
			);
			if (message) throw new Error(message);
		} catch (error) {
			new Notice(`Could not open file: ${errorMessage(error)}`);
		}
	}
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
