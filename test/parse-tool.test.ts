import { describe, expect, test } from "bun:test";
import { parseTool, ToolParseError } from "../src/compiler/parse-tool.ts";

const fixture = new URL(
	"../spikes/fixtures/typed-tool.fixture",
	import.meta.url,
);

describe("parseTool", () => {
	test("extracts common, server, and client TypeScript", async () => {
		const parsed = parseTool(await Bun.file(fixture).text());

		expect(parsed.manifest.name).toBe("typed-greeting");
		expect(parsed.blocks.map((block) => block.role)).toEqual([
			"common",
			"server",
			"client",
		]);
		expect(parsed.browserHtml).not.toContain("createServer<Server>");
		expect(parsed.browserHtml).not.toContain("interface Server");
		expect(parsed.browserHtml).toContain("/.htmltool/client.js");
	});

	test("extracts sorted embedded dependencies", () => {
		const parsed = parseTool(`
			<script type="application/htmltool+json">
				{"name":"portable","dependencies":{"zod":"4.4.3","htmltool":"github:arlyon/htmltools#v0.3.0"}}
			</script>
			<script lang="ts" server>export default {}</script>
			<script lang="ts" client>document.body.textContent = "ready"</script>
		`);

		expect(parsed.manifest.dependencies).toEqual({
			htmltool: "github:arlyon/htmltools#v0.3.0",
			zod: "4.4.3",
		});
	});

	test("rejects invalid embedded dependencies", () => {
		expect(() =>
			parseTool(`
				<script type="application/htmltool+json">{"name":"invalid","dependencies":[]}</script>
				<script lang="ts" server></script>
				<script lang="ts" client></script>
			`),
		).toThrow("manifest.dependencies must be a JSON object");
		expect(() =>
			parseTool(`
				<script type="application/htmltool+json">{"name":"invalid","dependencies":{"pkg":"workspace:*"}}</script>
				<script lang="ts" server></script>
				<script lang="ts" client></script>
			`),
		).toThrow("cannot use workspace:");
	});

	test("extracts annotated MCP UI fragments without server scripts", () => {
		const parsed = parseTool(`<!doctype html>
			<html><head>
				<title>Example</title>
				<style>main { color: red }</style>
				<script type="application/htmltool+json">{"name":"example"}</script>
				<script lang="ts" server>export default { inspect: () => ({ ok: true }) }</script>
				<script lang="ts" client>document.body.dataset.ready = "true"</script>
			</head><body>
				<inspect-view data-htmltool-ui="inspect"><strong>Result</strong></inspect-view>
			</body></html>`);

		expect(parsed.ui).toHaveLength(1);
		expect(parsed.ui[0]?.toolName).toBe("inspect");
		expect(parsed.ui[0]?.html).toContain(
			'<inspect-view data-htmltool-ui="inspect"',
		);
		expect(parsed.ui[0]?.html).toContain("<strong>Result</strong>");
		expect(parsed.appHeadHtml).toContain("<title>Example</title>");
		expect(parsed.appHeadHtml).toContain("main { color: red }");
		expect(parsed.appHeadHtml).not.toContain("export default");
		expect(parsed.appHeadHtml).not.toContain("document.body.dataset");
	});

	test("requires MCP UI fragments to be inside the body", () => {
		expect(() =>
			parseTool(`
				<head><template data-htmltool-ui="inspect"></template></head>
				<script type="application/htmltool+json">{"name":"invalid"}</script>
				<script lang="ts" server></script>
				<script lang="ts" client></script>
			`),
		).toThrow("must annotate an element inside the document body");
	});

	test("requires MCP UI roots to be custom elements", () => {
		expect(() =>
			parseTool(`
				<script type="application/htmltool+json">{"name":"invalid"}</script>
				<script lang="ts" server></script>
				<script lang="ts" client></script>
				<section data-htmltool-ui="inspect"></section>
			`),
		).toThrow("must annotate a hyphenated custom element");
	});

	test("rejects reserved custom-element names", () => {
		expect(() =>
			parseTool(`
				<script type="application/htmltool+json">{"name":"invalid"}</script>
				<script lang="ts" server></script>
				<script lang="ts" client></script>
				<annotation-xml data-htmltool-ui="inspect"></annotation-xml>
			`),
		).toThrow("must annotate a hyphenated custom element");
	});

	test("rejects duplicate MCP UI targets", () => {
		expect(() =>
			parseTool(`
				<script type="application/htmltool+json">{"name":"invalid"}</script>
				<script lang="ts" server></script>
				<script lang="ts" client></script>
				<inspect-view data-htmltool-ui="inspect"></inspect-view>
				<other-view data-htmltool-ui="inspect"></other-view>
			`),
		).toThrow("Only one data-htmltool-ui element may target");
	});

	test("maps each custom element to only one launch tool", () => {
		expect(() =>
			parseTool(`
				<script type="application/htmltool+json">{"name":"invalid"}</script>
				<script lang="ts" server></script>
				<script lang="ts" client></script>
				<inspect-view data-htmltool-ui="inspect"></inspect-view>
				<inspect-view data-htmltool-ui="preview"></inspect-view>
			`),
		).toThrow("may launch from only one MCP tool");
	});

	test("rejects empty MCP UI targets", () => {
		expect(() =>
			parseTool(`
				<script type="application/htmltool+json">{"name":"invalid"}</script>
				<script lang="ts" server></script>
				<script lang="ts" client></script>
				<inspect-view data-htmltool-ui></inspect-view>
			`),
		).toThrow("requires an MCP tool name");
	});

	test("rejects missing manifests", () => {
		expect(() =>
			parseTool(
				'<script lang="ts" server></script><script lang="ts" client></script>',
			),
		).toThrow(ToolParseError);
	});

	test("requires lang=ts on role blocks", () => {
		expect(() =>
			parseTool(`
				<script type="application/htmltool+json">{"name":"invalid"}</script>
				<script type="text/typescript" server></script>
				<script type="text/typescript" client></script>
			`),
		).toThrow('must use lang="ts"');
	});
});
