import { Notice, PluginSettingTab, Setting, type App } from "obsidian";
import type HtmlToolPlugin from "./main.js";
import { checkExecutable } from "./tool-process.js";

export class HtmlToolSettingTab extends PluginSettingTab {
	constructor(
		app: App,
		private readonly htmlToolPlugin: HtmlToolPlugin,
	) {
		super(app, htmlToolPlugin);
	}

	display(): void {
		this.containerEl.empty();
		this.containerEl.createEl("h2", { text: "HTMLTool" });

		new Setting(this.containerEl)
			.setName("Executable")
			.setDesc(
				"Command name or absolute path for the installed HTMLTool executable.",
			)
			.addText((text) => {
				text
					.setPlaceholder("htmltool")
					.setValue(this.htmlToolPlugin.settings.executablePath)
					.onChange(async (value) => {
						this.htmlToolPlugin.settings.executablePath = value;
						await this.htmlToolPlugin.saveSettings();
					});
			})
			.addButton((button) => {
				button.setButtonText("Test").onClick(async () => {
					button.setDisabled(true);
					try {
						await checkExecutable(this.htmlToolPlugin.settings.executablePath);
						new Notice("HTMLTool executable is available.");
					} catch (error) {
						new Notice(errorMessage(error));
					} finally {
						button.setDisabled(false);
					}
				});
			});
	}
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
