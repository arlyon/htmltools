import { Plugin } from "obsidian";
import { HtmlToolView, VIEW_TYPE_HTMLTOOL } from "./htmltool-view.js";
import { HtmlToolSettingTab } from "./settings-tab.js";

export interface HtmlToolSettings {
	executablePath: string;
}

const DEFAULT_SETTINGS: HtmlToolSettings = {
	executablePath: "htmltool",
};

export default class HtmlToolPlugin extends Plugin {
	settings: HtmlToolSettings = DEFAULT_SETTINGS;

	async onload(): Promise<void> {
		await this.loadSettings();
		this.registerView(
			VIEW_TYPE_HTMLTOOL,
			(leaf) => new HtmlToolView(leaf, this),
		);
		this.registerExtensions(["html"], VIEW_TYPE_HTMLTOOL);
		this.addSettingTab(new HtmlToolSettingTab(this.app, this));
	}

	async loadSettings(): Promise<void> {
		this.settings = {
			...DEFAULT_SETTINGS,
			...(await this.loadData()),
		};
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}
}
