export function renderTool(
	contentEl: HTMLElement,
	name: string,
	url: URL,
): void {
	prepare(contentEl);
	const frame = contentEl.createEl("iframe", {
		cls: "htmltool-frame",
		attr: {
			src: url.href,
			title: name,
			referrerpolicy: "no-referrer",
			sandbox:
				"allow-downloads allow-forms allow-modals allow-same-origin allow-scripts allow-top-navigation-by-user-activation",
		},
	});
	frame.setAttr("data-htmltool-url", url.href);
}

export function renderStatus(
	contentEl: HTMLElement,
	title: string,
	detail: string,
): void {
	prepare(contentEl);
	const status = contentEl.createDiv({ cls: "htmltool-state" });
	status.createDiv({ cls: "htmltool-state-pulse" });
	status.createEl("h2", { text: title });
	status.createEl("p", { text: detail });
}

export function renderError(
	contentEl: HTMLElement,
	title: string,
	detail: string,
): void {
	prepare(contentEl);
	const state = contentEl.createDiv({
		cls: "htmltool-state htmltool-state-error",
	});
	state.createEl("h2", { text: title });
	state.createEl("p", { text: detail });
}

export function renderPlainHtml(
	contentEl: HTMLElement,
	fileName: string,
	source: string,
): HTMLButtonElement {
	prepare(contentEl);
	const fallback = contentEl.createDiv({ cls: "htmltool-fallback" });
	const header = fallback.createDiv({ cls: "htmltool-fallback-header" });
	const copy = header.createDiv();
	copy.createEl("h2", { text: fileName });
	copy.createEl("p", {
		text: "This file does not contain an HTMLTool manifest.",
	});
	const button = header.createEl("button", {
		cls: "mod-cta",
		text: "Open in default app",
	});
	const sourceView = fallback.createEl("pre", { cls: "htmltool-source" });
	sourceView.createEl("code", { text: source });
	return button;
}

function prepare(contentEl: HTMLElement): void {
	contentEl.empty();
	contentEl.addClass("htmltool-view");
}
