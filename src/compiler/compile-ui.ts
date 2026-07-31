import { realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { parseFragment, type DefaultTreeAdapterTypes } from "parse5";
import type { ParsedTool } from "./parse-tool.ts";

export interface CompiledUi {
	toolName: string;
	uri: string;
	html: string;
}

interface AssetContext {
	toolDirectory: string;
	realToolDirectory: Promise<string>;
	dataUrls: Map<string, Promise<string>>;
	stylesheets: Map<string, Promise<string>>;
	countedPaths: Set<string>;
	assetCount: number;
	totalAssetBytes: number;
}

interface TextReplacement {
	startOffset: number;
	endOffset: number;
	text: string;
}

type ElementAttribute = DefaultTreeAdapterTypes.Element["attrs"][number];

const ASSET_ATTRIBUTES: Record<string, string[]> = {
	a: ["download:href"],
	audio: ["src"],
	image: ["href"],
	img: ["src", "srcset"],
	input: ["src"],
	source: ["src", "srcset"],
	track: ["src"],
	use: ["href"],
	video: ["src", "poster"],
};

const ASSET_LINK_RELS = new Set([
	"apple-touch-icon",
	"icon",
	"mask-icon",
	"preload",
]);
const UNSUPPORTED_FETCH_ELEMENTS = new Set([
	"base",
	"embed",
	"frame",
	"iframe",
	"object",
]);
const UNSUPPORTED_LINK_RELS = new Set([
	"dns-prefetch",
	"manifest",
	"modulepreload",
	"prefetch",
	"preconnect",
]);
const MAX_ASSET_COUNT = 256;
const MAX_ASSET_BYTES = 10 * 1024 * 1024;
const MAX_TOTAL_ASSET_BYTES = 25 * 1024 * 1024;
const MAX_APP_HTML_BYTES = 40 * 1024 * 1024;

export async function compileUiDocuments(
	parsed: ParsedTool,
	toolDirectory: string,
	clientBundle: string,
): Promise<CompiledUi[]> {
	const assets: AssetContext = {
		toolDirectory,
		realToolDirectory: realpath(toolDirectory),
		dataUrls: new Map(),
		stylesheets: new Map(),
		countedPaths: new Set(),
		assetCount: 0,
		totalAssetBytes: 0,
	};
	const headHtml = await bundleHtmlFragment(
		parsed.appHeadHtml,
		toolDirectory,
		assets,
	);
	const uiHtml: string[] = [];
	for (const ui of parsed.ui) {
		uiHtml.push(await bundleHtmlFragment(ui.html, toolDirectory, assets));
	}
	const safeClientBundle = clientBundle.replace(/<\/script/gi, "<\\/script");
	return parsed.ui.map((ui, index) => {
		const html = [
			"<!doctype html>",
			'<html data-htmltool-mcp-app="">',
			"<head>",
			'<meta charset="utf-8">',
			headHtml,
			"</head>",
			"<body>",
			uiHtml[index] ?? ui.html,
			`<script type="module">${safeClientBundle}</script>`,
			"</body>",
			"</html>",
		].join("\n");
		if (Buffer.byteLength(html) > MAX_APP_HTML_BYTES) {
			throw new Error(
				`MCP App ${JSON.stringify(ui.toolName)} exceeds ${MAX_APP_HTML_BYTES} bytes`,
			);
		}
		return {
			toolName: ui.toolName,
			uri: `ui://htmltool/${uriSegment(parsed.manifest.name)}/${uriSegment(ui.toolName)}.html`,
			html,
		};
	});
}

async function bundleHtmlFragment(
	source: string,
	baseDirectory: string,
	assets: AssetContext,
): Promise<string> {
	const fragment = parseFragment(source, { sourceCodeLocationInfo: true });
	const replacements: TextReplacement[] = [];
	const elements: DefaultTreeAdapterTypes.Element[] = [];
	walkElements(fragment, (element) => elements.push(element));
	await elements.reduce(
		(pending, element) =>
			pending.then(() =>
				processElement(source, element, baseDirectory, assets, replacements),
			),
		Promise.resolve(),
	);
	return applyTextReplacements(source, replacements);
}

async function processElement(
	source: string,
	element: DefaultTreeAdapterTypes.Element,
	baseDirectory: string,
	assets: AssetContext,
	replacements: TextReplacement[],
): Promise<void> {
	if (stripBrowserCsp(element, replacements)) return;
	assertSupportedElement(element);
	if (element.tagName === "link" && hasRel(element, "stylesheet")) {
		await inlineStylesheetLink(element, baseDirectory, assets, replacements);
		return;
	}
	if (element.tagName === "script") {
		throw atElement(
			element,
			"MCP App scripts must use an htmltool client block",
		);
	}
	await bundleElementStyles(
		source,
		element,
		baseDirectory,
		assets,
		replacements,
	);
	await bundleElementAssets(element, baseDirectory, assets, replacements);
}

function stripBrowserCsp(
	element: DefaultTreeAdapterTypes.Element,
	replacements: TextReplacement[],
): boolean {
	if (element.tagName !== "meta") return false;
	const directive = attribute(element, "http-equiv")?.value.toLowerCase();
	if (
		directive !== "content-security-policy" &&
		directive !== "content-security-policy-report-only"
	) {
		return false;
	}
	const location = element.sourceCodeLocation;
	if (!location) throw atElement(element, "Could not locate browser CSP meta");
	replacements.push({
		startOffset: location.startOffset,
		endOffset: location.endOffset,
		text: "",
	});
	return true;
}

function assertSupportedElement(
	element: DefaultTreeAdapterTypes.Element,
): void {
	if (UNSUPPORTED_FETCH_ELEMENTS.has(element.tagName)) {
		throw atElement(
			element,
			`MCP Apps do not support <${element.tagName}> resources`,
		);
	}
	if (
		element.tagName === "link" &&
		[...UNSUPPORTED_LINK_RELS].some((rel) => hasRel(element, rel))
	) {
		throw atElement(element, "MCP App link relation is not supported");
	}
	if (
		element.tagName === "meta" &&
		attribute(element, "http-equiv")?.value.toLowerCase() === "refresh"
	) {
		throw atElement(element, "MCP Apps do not support meta refresh");
	}
}

async function bundleElementStyles(
	source: string,
	element: DefaultTreeAdapterTypes.Element,
	baseDirectory: string,
	assets: AssetContext,
	replacements: TextReplacement[],
): Promise<void> {
	if (element.tagName === "style") {
		const location = element.sourceCodeLocation;
		if (location?.startTag && location.endTag) {
			const css = source.slice(
				location.startTag.endOffset,
				location.endTag.startOffset,
			);
			replacements.push({
				startOffset: location.startTag.endOffset,
				endOffset: location.endTag.startOffset,
				text: await bundleCss(css, baseDirectory, assets, []),
			});
		}
	}
	const style = attribute(element, "style");
	if (!style) return;
	replaceAttribute(
		element,
		style,
		await bundleCss(style.value, baseDirectory, assets, []),
		replacements,
	);
}

async function bundleElementAssets(
	element: DefaultTreeAdapterTypes.Element,
	baseDirectory: string,
	assets: AssetContext,
	replacements: TextReplacement[],
): Promise<void> {
	for (const specification of assetAttributes(element)) {
		const [requiredAttribute, name = requiredAttribute] =
			specification.split(":");
		if (requiredAttribute !== name && !attribute(element, requiredAttribute)) {
			continue;
		}
		const current = attribute(element, name);
		if (!current) continue;
		const value =
			name === "srcset"
				? await bundleSrcset(current.value, baseDirectory, assets)
				: await bundleReference(current.value, baseDirectory, assets, "asset");
		replaceAttribute(element, current, value, replacements);
	}
}

function assetAttributes(element: DefaultTreeAdapterTypes.Element): string[] {
	const attributes = [...(ASSET_ATTRIBUTES[element.tagName] ?? [])];
	if (
		element.tagName === "link" &&
		[...ASSET_LINK_RELS].some((rel) => hasRel(element, rel))
	) {
		attributes.push("href");
	}
	return attributes;
}

async function inlineStylesheetLink(
	element: DefaultTreeAdapterTypes.Element,
	baseDirectory: string,
	assets: AssetContext,
	replacements: TextReplacement[],
): Promise<void> {
	const href = attribute(element, "href");
	if (!href)
		throw atElement(element, "MCP App stylesheet links require an href");
	if (isEmbeddedReference(href.value)) return;
	const location = element.sourceCodeLocation;
	if (!location) throw new Error("Could not locate an MCP App stylesheet");
	const stylesheetPath = localAssetPath(
		href.value,
		baseDirectory,
		assets.toolDirectory,
		"stylesheet",
	).path;
	const stylesheet = await bundleStylesheet(stylesheetPath, assets, []);
	const media = attribute(element, "media")?.value;
	const mediaAttribute = media ? ` media="${escapeHtmlAttribute(media)}"` : "";
	replacements.push({
		startOffset: location.startOffset,
		endOffset: location.endOffset,
		text: `<style data-htmltool-href="${escapeHtmlAttribute(href.value)}"${mediaAttribute}>\n${stylesheet.replace(/<\/style/gi, "<\\/style")}\n</style>`,
	});
}

async function bundleStylesheet(
	path: string,
	assets: AssetContext,
	stack: string[],
): Promise<string> {
	if (stack.includes(path)) {
		throw new Error(
			`Cyclic MCP App stylesheet import: ${relative(assets.toolDirectory, path)}`,
		);
	}
	const cached = assets.stylesheets.get(path);
	if (cached) return cached;
	const pending = (async () => {
		const file = Bun.file(path);
		if (!(await file.exists())) {
			throw new Error(
				`MCP App stylesheet not found: ${relative(assets.toolDirectory, path)}`,
			);
		}
		await validateAssetFile(path, assets);
		return bundleCss(await file.text(), dirname(path), assets, [
			...stack,
			path,
		]);
	})();
	assets.stylesheets.set(path, pending);
	return pending;
}

async function bundleCss(
	css: string,
	baseDirectory: string,
	assets: AssetContext,
	stack: string[],
): Promise<string> {
	const protectedImports = cssProtectedOffsets(css);
	const withImports = await replaceAsync(
		css,
		/@import\s+(?:url\(\s*(?:"([^"]+)"|'([^']+)'|([^)'"\s]+))\s*\)|"([^"]+)"|'([^']+)')/gi,
		async (match) => {
			if (protectedImports[match.startOffset]) return match.text;
			const reference = match.captures.find((capture) => capture !== undefined);
			if (!reference || isEmbeddedReference(reference)) return match.text;
			const path = localAssetPath(
				reference,
				baseDirectory,
				assets.toolDirectory,
				"stylesheet import",
			).path;
			const imported = await bundleStylesheet(path, assets, stack);
			return `@import url("${textDataUrl("text/css", imported)}")`;
		},
	);
	const protectedUrls = cssProtectedOffsets(withImports);
	return replaceAsync(
		withImports,
		/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*?))\s*\)/gi,
		async (match) => {
			if (protectedUrls[match.startOffset]) return match.text;
			const reference = match.captures
				.find((capture) => capture !== undefined)
				?.trim();
			if (!reference || isEmbeddedReference(reference)) return match.text;
			const value = await bundleReference(
				reference,
				baseDirectory,
				assets,
				"CSS asset",
			);
			return `url("${value}")`;
		},
	);
}

async function bundleSrcset(
	value: string,
	baseDirectory: string,
	assets: AssetContext,
): Promise<string> {
	if (/data:/i.test(value)) {
		throw new Error(
			"MCP App srcset does not accept pre-existing data URLs; use src instead",
		);
	}
	const bundledCandidates: string[] = [];
	for (const candidate of value.split(",")) {
		const [reference, ...descriptor] = candidate.trim().split(/\s+/);
		if (!reference) continue;
		const bundled = await bundleReference(
			reference,
			baseDirectory,
			assets,
			"srcset asset",
		);
		bundledCandidates.push([bundled, ...descriptor].join(" "));
	}
	return bundledCandidates.join(", ");
}

async function bundleReference(
	reference: string,
	baseDirectory: string,
	assets: AssetContext,
	kind: string,
): Promise<string> {
	if (isEmbeddedReference(reference)) return reference;
	const resolved = localAssetPath(
		reference,
		baseDirectory,
		assets.toolDirectory,
		kind,
	);
	let pending = assets.dataUrls.get(resolved.path);
	if (!pending) {
		pending = fileDataUrl(resolved.path, assets);
		assets.dataUrls.set(resolved.path, pending);
	}
	return `${await pending}${resolved.fragment}`;
}

async function fileDataUrl(
	path: string,
	assets: AssetContext,
): Promise<string> {
	const file = Bun.file(path);
	if (!(await file.exists())) {
		throw new Error(
			`MCP App asset not found: ${relative(assets.toolDirectory, path)}`,
		);
	}
	await validateAssetFile(path, assets);
	const bytes = Buffer.from(await file.arrayBuffer()).toString("base64");
	return `data:${file.type || "application/octet-stream"};base64,${bytes}`;
}

async function validateAssetFile(
	path: string,
	assets: AssetContext,
): Promise<void> {
	const info = await stat(path);
	if (!info.isFile()) {
		throw new Error(
			`MCP App assets must be regular files: ${relative(assets.toolDirectory, path)}`,
		);
	}
	await assertRealAssetInsideTool(path, assets);
	if (assets.countedPaths.has(path)) return;
	if (info.size > MAX_ASSET_BYTES) {
		throw new Error(
			`MCP App asset exceeds ${MAX_ASSET_BYTES} bytes: ${relative(assets.toolDirectory, path)}`,
		);
	}
	if (assets.assetCount + 1 > MAX_ASSET_COUNT) {
		throw new Error(`MCP App exceeds the ${MAX_ASSET_COUNT} asset limit`);
	}
	if (assets.totalAssetBytes + info.size > MAX_TOTAL_ASSET_BYTES) {
		throw new Error(
			`MCP App assets exceed ${MAX_TOTAL_ASSET_BYTES} total bytes`,
		);
	}
	assets.countedPaths.add(path);
	assets.assetCount += 1;
	assets.totalAssetBytes += info.size;
}

async function assertRealAssetInsideTool(
	path: string,
	assets: AssetContext,
): Promise<void> {
	const [toolDirectory, assetPath] = await Promise.all([
		assets.realToolDirectory,
		realpath(path),
	]);
	const relativePath = relative(toolDirectory, assetPath);
	if (escapesDirectory(relativePath)) {
		throw new Error(
			`MCP App asset resolves outside the tool directory: ${relative(assets.toolDirectory, path)}`,
		);
	}
}

function textDataUrl(mimeType: string, value: string): string {
	return `data:${mimeType};base64,${Buffer.from(value).toString("base64")}`;
}

function localAssetPath(
	reference: string,
	baseDirectory: string,
	toolDirectory: string,
	kind: string,
): { path: string; fragment: string } {
	assertLocalReference(reference, kind);
	const { encodedPath, fragment } = splitReference(reference);
	const requestedPath = decodeAssetPath(encodedPath, reference, kind);
	const path = requestedPath.startsWith("/")
		? resolve(toolDirectory, requestedPath.replace(/^\/+/, ""))
		: resolve(baseDirectory, requestedPath);
	assertInsideToolDirectory(path, toolDirectory, reference, kind);
	return { path, fragment };
}

function assertLocalReference(reference: string, kind: string): void {
	if (/^[a-z][a-z\d+.-]*:/i.test(reference) || reference.startsWith("//")) {
		throw new Error(
			`MCP App ${kind} must be local or a data URL: ${reference}`,
		);
	}
}

function splitReference(reference: string): {
	encodedPath: string;
	fragment: string;
} {
	const hashIndex = reference.indexOf("#");
	const fragment = hashIndex >= 0 ? reference.slice(hashIndex) : "";
	const withoutFragment =
		hashIndex >= 0 ? reference.slice(0, hashIndex) : reference;
	return {
		encodedPath: withoutFragment.split("?", 1)[0] ?? "",
		fragment,
	};
}

function decodeAssetPath(
	encodedPath: string,
	reference: string,
	kind: string,
): string {
	let requestedPath: string;
	try {
		requestedPath = decodeURIComponent(encodedPath);
	} catch {
		throw new Error(`Invalid MCP App ${kind} path: ${reference}`);
	}
	if (requestedPath === "") {
		throw new Error(`Invalid MCP App ${kind} path: ${reference}`);
	}
	return requestedPath;
}

function assertInsideToolDirectory(
	path: string,
	toolDirectory: string,
	reference: string,
	kind: string,
): void {
	const relativePath = relative(toolDirectory, path);
	if (escapesDirectory(relativePath)) {
		throw new Error(`MCP App ${kind} escapes the tool directory: ${reference}`);
	}
}

function escapesDirectory(relativePath: string): boolean {
	return (
		relativePath === ".." ||
		relativePath.startsWith(`..${sep}`) ||
		isAbsolute(relativePath)
	);
}

function isEmbeddedReference(reference: string): boolean {
	const value = reference.trim().toLowerCase();
	return value.startsWith("data:") || value.startsWith("#");
}

function hasRel(
	element: DefaultTreeAdapterTypes.Element,
	expected: string,
): boolean {
	return (
		attribute(element, "rel")
			?.value.toLowerCase()
			.split(/\s+/)
			.includes(expected) ?? false
	);
}

function attribute(
	element: DefaultTreeAdapterTypes.Element,
	name: string,
): ElementAttribute | undefined {
	return element.attrs.find((candidate) => candidate.name === name);
}

function replaceAttribute(
	element: DefaultTreeAdapterTypes.Element,
	current: ElementAttribute,
	value: string,
	replacements: TextReplacement[],
): void {
	const location = element.sourceCodeLocation?.attrs?.[current.name];
	if (!location) throw atElement(element, `Could not locate ${current.name}`);
	replacements.push({
		startOffset: location.startOffset,
		endOffset: location.endOffset,
		text: `${current.name}="${escapeHtmlAttribute(value)}"`,
	});
}

function atElement(
	element: DefaultTreeAdapterTypes.Element,
	message: string,
): Error {
	const line = element.sourceCodeLocation?.startLine;
	return new Error(line ? `${message} at line ${line}` : message);
}

function walkElements(
	node: DefaultTreeAdapterTypes.Node,
	visit: (element: DefaultTreeAdapterTypes.Element) => void,
): void {
	if ("tagName" in node) visit(node);
	if ("childNodes" in node) {
		for (const child of node.childNodes) walkElements(child, visit);
	}
	if ("content" in node) walkElements(node.content, visit);
}

function cssProtectedOffsets(source: string): Uint8Array {
	const protectedOffsets = new Uint8Array(source.length);
	let index = 0;
	while (index < source.length) {
		const stop = cssProtectedRangeEnd(source, index);
		if (stop === index) {
			index += 1;
			continue;
		}
		protectedOffsets.fill(1, index, stop);
		index = stop;
	}
	return protectedOffsets;
}

function cssProtectedRangeEnd(source: string, start: number): number {
	if (source[start] === "/" && source[start + 1] === "*") {
		const end = source.indexOf("*/", start + 2);
		return end < 0 ? source.length : end + 2;
	}
	const quote = source[start];
	if (quote !== '"' && quote !== "'") return start;
	let index = start + 1;
	while (index < source.length) {
		if (source[index] === "\\") {
			index += 2;
			continue;
		}
		if (source[index] === quote) return index + 1;
		index += 1;
	}
	return source.length;
}

interface AsyncMatch {
	text: string;
	captures: Array<string | undefined>;
	startOffset: number;
}

async function replaceAsync(
	source: string,
	pattern: RegExp,
	replacer: (match: AsyncMatch) => Promise<string>,
): Promise<string> {
	const replacements: TextReplacement[] = [];
	for (const match of source.matchAll(pattern)) {
		replacements.push({
			startOffset: match.index,
			endOffset: match.index + match[0].length,
			text: await replacer({
				text: match[0],
				captures: match.slice(1),
				startOffset: match.index,
			}),
		});
	}
	return applyTextReplacements(source, replacements);
}

function applyTextReplacements(
	source: string,
	replacements: TextReplacement[],
): string {
	let output = source;
	for (const replacement of replacements.sort(
		(left, right) => right.startOffset - left.startOffset,
	)) {
		output =
			output.slice(0, replacement.startOffset) +
			replacement.text +
			output.slice(replacement.endOffset);
	}
	return output;
}

function uriSegment(value: string): string {
	return encodeURIComponent(value).replace(
		/[!'()*]/g,
		(character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
	);
}

function escapeHtmlAttribute(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/"/g, "&quot;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
}
