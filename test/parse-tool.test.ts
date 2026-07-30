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
