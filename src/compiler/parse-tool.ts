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

export interface ParsedTool {
	manifest: ToolManifest;
	blocks: ToolBlock[];
	browserHtml: string;
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

const TYPESCRIPT_LANGS = new Set(["ts", "typescript"]);
const MANIFEST_MIME = "application/htmltool+json";
const BLOCK_ROLES: BlockRole[] = ["common", "server", "client"];

export function parseTool(source: string): ParsedTool {
	const document = parse(source, { sourceCodeLocationInfo: true });
	const blocks: ToolBlock[] = [];
	const replacements: Replacement[] = [];
	let manifest: ToolManifest | undefined;
	let clientEntrypointInjected = false;

	walk(document, (element) => {
		if (element.tagName !== "script") return;

		const type = attributeValue(element, "type")?.toLowerCase();
		if (type === MANIFEST_MIME) {
			if (manifest) {
				throw atElement(element, "Only one htmltool manifest is allowed");
			}

			const content = scriptContent(source, element);
			try {
				manifest = parseManifest(content.source);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				throw new ToolParseError(
					`Invalid htmltool manifest: ${message}`,
					content.startLine,
					content.startColumn,
				);
			}
			replacements.push(removalFor(element));
			return;
		}

		const roles = BLOCK_ROLES.filter((role) => hasAttribute(element, role));
		if (roles.length === 0) return;
		const lang = attributeValue(element, "lang")?.toLowerCase();
		if (!lang || !TYPESCRIPT_LANGS.has(lang)) {
			throw atElement(
				element,
				`htmltool ${roles[0]} blocks must use lang="ts"`,
			);
		}
		if (roles.length !== 1) {
			throw atElement(
				element,
				`A TypeScript block must have exactly one role: ${BLOCK_ROLES.join(", ")}`,
			);
		}

		const content = scriptContent(source, element);
		blocks.push({ role: roles[0], ...content });

		const location = requiredElementLocation(element);
		const injectClientEntrypoint =
			roles[0] === "client" && !clientEntrypointInjected;
		if (injectClientEntrypoint) clientEntrypointInjected = true;
		replacements.push({
			startOffset: location.startOffset,
			endOffset: location.endOffset,
			text: injectClientEntrypoint
				? '<script type="module" src="/.htmltool/client.js"></script>'
				: preserveLineBreaks(
						source.slice(location.startOffset, location.endOffset),
					),
		});
	});

	if (!manifest) {
		throw new ToolParseError("Missing application/htmltool+json manifest");
	}
	if (!blocks.some((block) => block.role === "server")) {
		throw new ToolParseError(
			"At least one server TypeScript block is required",
		);
	}
	if (!blocks.some((block) => block.role === "client")) {
		throw new ToolParseError(
			"At least one client TypeScript block is required",
		);
	}

	return {
		manifest,
		blocks,
		browserHtml: applyReplacements(source, replacements),
	};
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
