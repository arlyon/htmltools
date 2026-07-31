import { parse, type DefaultTreeAdapterTypes } from "parse5";

export type BlockRole = "common" | "server" | "client";

export interface SourceRange {
	startOffset: number;
	endOffset: number;
	startLine: number;
	startColumn: number;
}

export interface ToolBlock extends SourceRange {
	role: BlockRole;
	source: string;
}

export interface ToolManifest {
	name: string;
}

export interface ToolUi extends SourceRange {
	toolName: string;
	html: string;
}

export interface ParsedTool {
	manifest: ToolManifest;
	blocks: ToolBlock[];
	browserHtml: string;
	appHeadHtml: string;
	ui: ToolUi[];
}

export class ToolParseError extends Error {
	constructor(
		message: string,
		readonly line?: number,
		readonly column?: number,
	) {
		super(message);
		this.name = "ToolParseError";
	}
}

interface Replacement {
	startOffset: number;
	endOffset: number;
	text: string;
}

interface UiElement {
	element: DefaultTreeAdapterTypes.Element;
	toolName: string;
}

interface ParseState {
	blocks: ToolBlock[];
	browserReplacements: Replacement[];
	appReplacements: Replacement[];
	uiElements: UiElement[];
	headElement?: DefaultTreeAdapterTypes.Element;
	manifest?: ToolManifest;
	clientEntrypointInjected: boolean;
}

const TYPESCRIPT_LANGS = new Set(["ts", "typescript"]);
const MANIFEST_MIME = "application/htmltool+json";
const BLOCK_ROLES: BlockRole[] = ["common", "server", "client"];
const RESERVED_CUSTOM_ELEMENT_NAMES = new Set([
	"annotation-xml",
	"color-profile",
	"font-face",
	"font-face-format",
	"font-face-name",
	"font-face-src",
	"font-face-uri",
	"missing-glyph",
]);

export function parseTool(source: string): ParsedTool {
	const document = parse(source, { sourceCodeLocationInfo: true });
	const state: ParseState = {
		blocks: [],
		browserReplacements: [],
		appReplacements: [],
		uiElements: [],
		clientEntrypointInjected: false,
	};
	walk(document, (element) => visitToolElement(source, state, element));

	if (!state.manifest) {
		throw new ToolParseError("Missing application/htmltool+json manifest");
	}
	if (!state.blocks.some((block) => block.role === "server")) {
		throw new ToolParseError(
			"At least one server TypeScript block is required",
		);
	}
	if (!state.blocks.some((block) => block.role === "client")) {
		throw new ToolParseError(
			"At least one client TypeScript block is required",
		);
	}

	return {
		manifest: state.manifest,
		blocks: state.blocks,
		browserHtml: applyReplacements(source, state.browserReplacements),
		appHeadHtml: state.headElement
			? elementInnerHtml(source, state.headElement, state.appReplacements)
			: "",
		ui: state.uiElements.map(({ element, toolName }) => ({
			toolName,
			html: elementOuterHtml(source, element, state.appReplacements),
			...sourceRangeFor(element),
		})),
	};
}

function visitToolElement(
	source: string,
	state: ParseState,
	element: DefaultTreeAdapterTypes.Element,
): void {
	if (element.tagName === "head" && element.sourceCodeLocation) {
		state.headElement = element;
	}
	collectUiElement(state.uiElements, element);
	if (element.tagName !== "script") return;

	const type = attributeValue(element, "type")?.toLowerCase();
	if (type === MANIFEST_MIME) {
		collectManifest(source, state, element);
		return;
	}
	collectTypeScriptBlock(source, state, element);
}

function collectUiElement(
	uiElements: UiElement[],
	element: DefaultTreeAdapterTypes.Element,
): void {
	const value = attributeValue(element, "data-htmltool-ui");
	if (value === undefined) return;
	if (!hasAncestorTag(element, "body")) {
		throw atElement(
			element,
			"data-htmltool-ui must annotate an element inside the document body",
		);
	}
	if (!isValidCustomElementName(element.tagName)) {
		throw atElement(
			element,
			"data-htmltool-ui must annotate a hyphenated custom element",
		);
	}
	const toolName = value.trim();
	if (toolName === "") {
		throw atElement(element, "data-htmltool-ui requires an MCP tool name");
	}
	if (/\s/.test(toolName)) {
		throw atElement(
			element,
			"data-htmltool-ui accepts exactly one MCP tool name",
		);
	}
	if (uiElements.some((candidate) => candidate.toolName === toolName)) {
		throw atElement(
			element,
			`Only one data-htmltool-ui element may target ${JSON.stringify(toolName)}`,
		);
	}
	if (
		uiElements.some(
			(candidate) => candidate.element.tagName === element.tagName,
		)
	) {
		throw atElement(
			element,
			`Custom element ${JSON.stringify(element.tagName)} may launch from only one MCP tool`,
		);
	}
	uiElements.push({ element, toolName });
}

function collectManifest(
	source: string,
	state: ParseState,
	element: DefaultTreeAdapterTypes.Element,
): void {
	if (state.manifest) {
		throw atElement(element, "Only one htmltool manifest is allowed");
	}
	const content = scriptContent(source, element);
	try {
		state.manifest = parseManifest(content.source);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new ToolParseError(
			`Invalid htmltool manifest: ${message}`,
			content.startLine,
			content.startColumn,
		);
	}
	const removal = removalFor(element);
	state.browserReplacements.push(removal);
	state.appReplacements.push(removal);
}

function collectTypeScriptBlock(
	source: string,
	state: ParseState,
	element: DefaultTreeAdapterTypes.Element,
): void {
	const roles = BLOCK_ROLES.filter((role) => hasAttribute(element, role));
	if (roles.length === 0) return;
	const lang = attributeValue(element, "lang")?.toLowerCase();
	if (!lang || !TYPESCRIPT_LANGS.has(lang)) {
		throw atElement(element, `htmltool ${roles[0]} blocks must use lang="ts"`);
	}
	if (roles.length !== 1) {
		throw atElement(
			element,
			`A TypeScript block must have exactly one role: ${BLOCK_ROLES.join(", ")}`,
		);
	}

	const role = roles[0];
	const content = scriptContent(source, element);
	state.blocks.push({ role, ...content });
	const location = requiredElementLocation(element);
	const injectClientEntrypoint =
		role === "client" && !state.clientEntrypointInjected;
	if (injectClientEntrypoint) state.clientEntrypointInjected = true;
	state.browserReplacements.push({
		startOffset: location.startOffset,
		endOffset: location.endOffset,
		text: injectClientEntrypoint
			? '<script type="module" src="/.htmltool/client.js"></script>'
			: preserveLineBreaks(
					source.slice(location.startOffset, location.endOffset),
				),
	});
	state.appReplacements.push(removalFor(element));
}

function parseManifest(source: string): ToolManifest {
	let value: unknown;
	try {
		value = JSON.parse(source);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`invalid JSON: ${message}`);
	}

	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("manifest must be a JSON object");
	}

	const candidate = value as Record<string, unknown>;
	if (typeof candidate.name !== "string" || candidate.name.trim() === "") {
		throw new Error("manifest.name must be a non-empty string");
	}
	return { name: candidate.name };
}

function walk(
	node: DefaultTreeAdapterTypes.Node,
	visit: (element: DefaultTreeAdapterTypes.Element) => void,
): void {
	if ("tagName" in node) visit(node);
	if ("childNodes" in node) {
		for (const child of node.childNodes) walk(child, visit);
	}
	if ("content" in node) walk(node.content, visit);
}

function scriptContent(
	source: string,
	element: DefaultTreeAdapterTypes.Element,
): Omit<ToolBlock, "role"> {
	const location = requiredElementLocation(element);
	if (!location.startTag || !location.endTag) {
		throw atElement(element, "htmltool script blocks require a closing tag");
	}

	const startOffset = location.startTag.endOffset;
	const endOffset = location.endTag.startOffset;
	const start = positionAt(source, startOffset);
	return {
		source: source.slice(startOffset, endOffset),
		startOffset,
		endOffset,
		startLine: start.line,
		startColumn: start.column,
	};
}

function elementInnerHtml(
	source: string,
	element: DefaultTreeAdapterTypes.Element,
	replacements: Replacement[],
): string {
	const location = requiredElementLocation(element);
	if (!location.startTag || !location.endTag) return "";
	return applyReplacementsToRange(
		source,
		replacements,
		location.startTag.endOffset,
		location.endTag.startOffset,
	);
}

function elementOuterHtml(
	source: string,
	element: DefaultTreeAdapterTypes.Element,
	replacements: Replacement[],
): string {
	const location = requiredElementLocation(element);
	return applyReplacementsToRange(
		source,
		replacements,
		location.startOffset,
		location.endOffset,
	);
}

function sourceRangeFor(element: DefaultTreeAdapterTypes.Element): SourceRange {
	const location = requiredElementLocation(element);
	return {
		startOffset: location.startOffset,
		endOffset: location.endOffset,
		startLine: location.startLine,
		startColumn: location.startCol,
	};
}

function isValidCustomElementName(tagName: string): boolean {
	return (
		/^[a-z][a-z0-9._-]*-[a-z0-9._-]+$/.test(tagName) &&
		!tagName.startsWith("xml") &&
		!RESERVED_CUSTOM_ELEMENT_NAMES.has(tagName)
	);
}

function hasAncestorTag(
	element: DefaultTreeAdapterTypes.Element,
	tagName: string,
): boolean {
	let ancestor: DefaultTreeAdapterTypes.ParentNode | null = element.parentNode;
	while (ancestor) {
		if ("tagName" in ancestor && ancestor.tagName === tagName) return true;
		ancestor = "parentNode" in ancestor ? ancestor.parentNode : null;
	}
	return false;
}

function attributeValue(
	element: DefaultTreeAdapterTypes.Element,
	name: string,
): string | undefined {
	return element.attrs.find((attribute) => attribute.name === name)?.value;
}

function hasAttribute(
	element: DefaultTreeAdapterTypes.Element,
	name: string,
): boolean {
	return element.attrs.some((attribute) => attribute.name === name);
}

function requiredElementLocation(
	element: DefaultTreeAdapterTypes.Element,
): NonNullable<DefaultTreeAdapterTypes.Element["sourceCodeLocation"]> {
	const location = element.sourceCodeLocation;
	if (!location)
		throw new ToolParseError("Parser did not provide source locations");
	return location;
}

function atElement(
	element: DefaultTreeAdapterTypes.Element,
	message: string,
): ToolParseError {
	const location = requiredElementLocation(element);
	return new ToolParseError(message, location.startLine, location.startCol);
}

function removalFor(element: DefaultTreeAdapterTypes.Element): Replacement {
	const location = requiredElementLocation(element);
	return {
		startOffset: location.startOffset,
		endOffset: location.endOffset,
		text: preserveLineBreaks(
			"\n".repeat(location.endLine - location.startLine),
		),
	};
}

function preserveLineBreaks(value: string): string {
	return value.replace(/[^\r\n]/g, " ");
}

function applyReplacementsToRange(
	source: string,
	replacements: Replacement[],
	startOffset: number,
	endOffset: number,
): string {
	return applyReplacements(
		source.slice(startOffset, endOffset),
		replacements.flatMap((replacement) =>
			replacement.startOffset >= startOffset &&
			replacement.endOffset <= endOffset
				? [
						{
							...replacement,
							startOffset: replacement.startOffset - startOffset,
							endOffset: replacement.endOffset - startOffset,
						},
					]
				: [],
		),
	);
}

function applyReplacements(
	source: string,
	replacements: Replacement[],
): string {
	let output = source;
	const orderedReplacements = [...replacements].sort(
		(left, right) => right.startOffset - left.startOffset,
	);
	for (const replacement of orderedReplacements) {
		output =
			output.slice(0, replacement.startOffset) +
			replacement.text +
			output.slice(replacement.endOffset);
	}
	return output;
}

function positionAt(
	source: string,
	offset: number,
): { line: number; column: number } {
	const before = source.slice(0, offset);
	const lines = before.split(/\r\n|\r|\n/);
	return { line: lines.length, column: lines.at(-1)!.length + 1 };
}
