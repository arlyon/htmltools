import { parse, type DefaultTreeAdapterTypes } from "parse5";

const MANIFEST_MIME = "application/htmltool+json";

export type HtmlToolInspection =
	| { kind: "not-tool" }
	| { kind: "tool"; name: string }
	| { kind: "invalid"; message: string };

export function inspectHtmlTool(source: string): HtmlToolInspection {
	const manifests: string[] = [];
	const document = parse(source);

	walk(document, (element) => {
		if (element.tagName !== "script") return;
		const type = element.attrs
			.find((attribute) => attribute.name === "type")
			?.value.toLowerCase();
		if (type !== MANIFEST_MIME) return;
		manifests.push(scriptText(element));
	});

	if (manifests.length === 0) return { kind: "not-tool" };
	if (manifests.length > 1) {
		return {
			kind: "invalid",
			message: "Only one HTMLTool manifest is allowed.",
		};
	}

	let value: unknown;
	try {
		value = JSON.parse(manifests[0]);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { kind: "invalid", message: `Invalid manifest JSON: ${message}` };
	}

	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return { kind: "invalid", message: "The manifest must be a JSON object." };
	}

	const name = (value as Record<string, unknown>).name;
	if (typeof name !== "string" || name.trim() === "") {
		return {
			kind: "invalid",
			message: "The manifest name must be a non-empty string.",
		};
	}

	return { kind: "tool", name };
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

function scriptText(element: DefaultTreeAdapterTypes.Element): string {
	let result = "";
	for (const node of element.childNodes) {
		if ("value" in node) result += node.value;
	}
	return result;
}
