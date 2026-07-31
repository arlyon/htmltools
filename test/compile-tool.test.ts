import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compileUiDocuments } from "../src/compiler/compile-ui.ts";
import { checkTool, compileTool } from "../src/compiler/compile-tool.ts";
import { parseTool } from "../src/compiler/parse-tool.ts";

const temporaryDirectories: string[] = [];
setDefaultTimeout(60_000);

afterEach(async () => {
	await Promise.all(
		temporaryDirectories
			.splice(0)
			.map((directory) => rm(directory, { recursive: true, force: true })),
	);
});

describe("compileTool", () => {
	test("resolves dependencies from the tool's package environment", async () => {
		const directory = await mkdtemp(join(tmpdir(), "htmltool-env-"));
		temporaryDirectories.push(directory);
		const dependencyDirectory = join(
			directory,
			"node_modules",
			"fixture-dependency",
		);
		await mkdir(dependencyDirectory, { recursive: true });
		await writeFile(
			join(dependencyDirectory, "package.json"),
			JSON.stringify({
				name: "fixture-dependency",
				type: "module",
				exports: {
					".": { types: "./index.d.ts", default: "./index.js" },
				},
			}),
		);
		await writeFile(
			join(dependencyDirectory, "index.d.ts"),
			'export declare const marker: "tool-environment";\n',
		);
		await writeFile(
			join(dependencyDirectory, "index.js"),
			'export const marker = "tool-environment";\n',
		);
		await writeFile(
			join(directory, "tsconfig.json"),
			JSON.stringify({
				compilerOptions: {
					target: "ES2023",
					module: "ESNext",
					moduleResolution: "Bundler",
					strict: true,
				},
			}),
		);

		const toolPath = join(directory, "index.html");
		await writeFile(
			toolPath,
			`<!doctype html>
<script type="application/htmltool+json">{"name":"environment-test"}</script>
<script lang="ts" common>
interface Server { readMarker(): string }
</script>
<script lang="ts" server>
import { marker } from "fixture-dependency";
export default { readMarker: () => marker };
</script>
<script lang="ts" client>
import { marker } from "fixture-dependency";
document.body.dataset.marker = marker;
</script>`,
		);

		const compiled = await compileTool(toolPath);

		expect(compiled.toolDirectory).toBe(directory);
		expect(await compiled.serverBundle.text()).toContain("tool-environment");
		expect(await compiled.clientBundle.text()).toContain("tool-environment");
		expect(existsSync(join(directory, ".htmltool"))).toBe(false);
	});

	test("packages annotated fragments as MCP App documents", async () => {
		const directory = await mkdtemp(join(process.cwd(), ".htmltool-ui-"));
		temporaryDirectories.push(directory);
		await writeFile(
			join(directory, "tool.css"),
			'@import "./palette.css";\n/* url("./missing-comment.png") */\n.result::before { content: "url(./missing-string.png)" }\n.result { color: green; background: url("./pixel.svg") }\n',
		);
		await writeFile(
			join(directory, "palette.css"),
			":root { --accent: green }\n",
		);
		await writeFile(
			join(directory, "pixel.svg"),
			'<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"></svg>',
		);
		const toolPath = join(directory, "index.html");
		await writeFile(
			toolPath,
			`<!doctype html>
			<html><head>
			<meta http-equiv="Content-Security-Policy" content="script-src 'self'; style-src 'self'">
			<link rel="stylesheet" href="./tool.css">
			<script type="application/htmltool+json">{"name":"ui-test"}</script>
			<script lang="ts" common>
			interface Server { inspect(input: { value: string }): { value: string } }
			</script>
			<script lang="ts" server>
			import { createServer, mcp, z } from "htmltool/server";
			export default createServer<Server>({
				inspect: mcp({
					description: "Inspect a value",
					input: z.object({ value: z.string() }),
					output: z.object({ value: z.string() }),
					run: ({ value }) => ({ value }),
				}),
			});
			</script>
			<script lang="ts" client>
			import { createClient } from "htmltool/client";
			const client = createClient<Server>();
			customElements.define("inspect-view", class extends HTMLElement {});
			void client.inspect({ value: "ready" });
			</script>
			</head><body>
			<p>Browser-only navigation</p>
			<inspect-view class="result" data-htmltool-ui="inspect">
				Result
				<img src="./pixel.svg" srcset="./pixel.svg 1x" alt="">
			</inspect-view>
			</body></html>`,
		);

		const compiled = await compileTool(toolPath);

		expect(compiled.ui).toHaveLength(1);
		expect(compiled.ui[0]?.toolName).toBe("inspect");
		expect(compiled.ui[0]?.uri).toBe("ui://htmltool/ui-test/inspect.html");
		expect(compiled.ui[0]?.html).toContain(
			'<inspect-view class="result" data-htmltool-ui="inspect">',
		);
		expect(compiled.ui[0]?.html).not.toContain("Browser-only navigation");
		expect(compiled.ui[0]?.html).toContain(".result { color: green;");
		expect(compiled.ui[0]?.html).toContain(
			'@import url("data:text/css;base64,',
		);
		expect(compiled.ui[0]?.html).toContain("data:image/svg+xml;base64,");
		expect(compiled.ui[0]?.html).not.toContain("./pixel.svg");
		expect(compiled.ui[0]?.html).not.toContain('<link rel="stylesheet"');
		expect(compiled.ui[0]?.html).not.toContain("Content-Security-Policy");
		expect(compiled.ui[0]?.html).toContain("htmltool_rpc");
		expect(compiled.ui[0]?.html).toContain("htmltool:result");
		expect(compiled.ui[0]?.html).toContain("customElements.whenDefined");
		expect(compiled.ui[0]?.html).toContain("htmltoolMountError");
		expect(compiled.ui[0]?.html).not.toContain("sourceMappingURL");
	});

	test("rejects remote MCP App stylesheets", async () => {
		const parsed = parseTool(`<!doctype html>
			<html><head>
			<link rel="stylesheet" href="https://example.com/tool.css">
			<script type="application/htmltool+json">{"name":"remote-style"}</script>
			<script lang="ts" server></script>
			<script lang="ts" client></script>
			</head><body><inspect-view data-htmltool-ui="inspect"></inspect-view></body></html>`);

		await expect(compileUiDocuments(parsed, process.cwd(), "")).rejects.toThrow(
			"MCP App stylesheet must be local",
		);
	});

	test("rejects MCP App assets outside the tool directory", async () => {
		const parsed = parseTool(`<!doctype html>
			<script type="application/htmltool+json">{"name":"escaping-asset"}</script>
			<script lang="ts" server></script>
			<script lang="ts" client></script>
			<asset-view data-htmltool-ui="inspect"><img src="../secret.png"></asset-view>`);

		await expect(compileUiDocuments(parsed, process.cwd(), "")).rejects.toThrow(
			"escapes the tool directory",
		);
	});

	test("rejects MCP App assets that escape through symlinks", async () => {
		const directory = await mkdtemp(join(process.cwd(), ".htmltool-assets-"));
		const outside = await mkdtemp(join(process.cwd(), ".htmltool-outside-"));
		temporaryDirectories.push(directory, outside);
		await writeFile(join(outside, "secret.png"), "secret");
		await symlink(join(outside, "secret.png"), join(directory, "linked.png"));
		const parsed = parseTool(`<!doctype html>
			<script type="application/htmltool+json">{"name":"linked-asset"}</script>
			<script lang="ts" server></script>
			<script lang="ts" client></script>
			<asset-view data-htmltool-ui="inspect"><img src="./linked.png"></asset-view>`);

		await expect(compileUiDocuments(parsed, directory, "")).rejects.toThrow(
			"resolves outside the tool directory",
		);
	});

	test("rejects ambiguous or remote srcset candidates", async () => {
		const parsed = parseTool(`<!doctype html>
			<script type="application/htmltool+json">{"name":"mixed-srcset"}</script>
			<script lang="ts" server></script>
			<script lang="ts" client></script>
			<asset-view data-htmltool-ui="inspect"><img srcset="data:image/png;base64,AAAA 1x, https://example.com/image.png 2x"></asset-view>`);

		await expect(compileUiDocuments(parsed, process.cwd(), "")).rejects.toThrow(
			"srcset does not accept pre-existing data URLs",
		);

		const remote = parseTool(`<!doctype html>
			<script type="application/htmltool+json">{"name":"remote-srcset"}</script>
			<script lang="ts" server></script>
			<script lang="ts" client></script>
			<asset-view data-htmltool-ui="inspect"><img srcset="https://example.com/image.png 2x, ./image.png 1x"></asset-view>`);
		await expect(compileUiDocuments(remote, process.cwd(), "")).rejects.toThrow(
			"must be local or a data URL",
		);
	});

	test("rejects unsupported embedded resources", async () => {
		const parsed = parseTool(`<!doctype html>
			<script type="application/htmltool+json">{"name":"iframe"}</script>
			<script lang="ts" server></script>
			<script lang="ts" client></script>
			<frame-view data-htmltool-ui="inspect"><iframe src="https://example.com"></iframe></frame-view>`);

		await expect(compileUiDocuments(parsed, process.cwd(), "")).rejects.toThrow(
			"do not support <iframe> resources",
		);
	});

	test("rejects cyclic stylesheet imports", async () => {
		const directory = await mkdtemp(join(process.cwd(), ".htmltool-css-"));
		temporaryDirectories.push(directory);
		await writeFile(join(directory, "a.css"), '@import "./b.css";');
		await writeFile(join(directory, "b.css"), '@import "./a.css";');
		const parsed = parseTool(`<!doctype html>
			<head><link rel="stylesheet" href="./a.css"><link rel="stylesheet" href="./b.css"></head>
			<script type="application/htmltool+json">{"name":"cyclic-css"}</script>
			<script lang="ts" server></script>
			<script lang="ts" client></script>
			<style-view data-htmltool-ui="inspect"></style-view>`);

		await expect(compileUiDocuments(parsed, directory, "")).rejects.toThrow(
			"Cyclic MCP App stylesheet import",
		);
	});

	test("rejects unmanaged MCP App scripts", async () => {
		const parsed = parseTool(`<!doctype html>
			<script type="application/htmltool+json">{"name":"external-script"}</script>
			<script lang="ts" server></script>
			<script lang="ts" client></script>
			<script-view data-htmltool-ui="inspect"><script src="./extra.js"></script></script-view>`);

		await expect(compileUiDocuments(parsed, process.cwd(), "")).rejects.toThrow(
			"scripts must use an htmltool client block",
		);
	});

	test("reserves TypeScript checking for the explicit check command", async () => {
		const directory = await mkdtemp(join(tmpdir(), "htmltool-check-"));
		temporaryDirectories.push(directory);
		const toolPath = join(directory, "index.html");
		await writeFile(
			toolPath,
			`<!doctype html>
<script type="application/htmltool+json">{"name":"check-test"}</script>
<script lang="ts" common>
interface Server { value(): number }
</script>
<script lang="ts" server>
export default { value: () => 1 };
</script>
<script lang="ts" client>
const invalid: number = "not a number";
document.body.dataset.value = String(invalid);
</script>`,
		);

		await expect(compileTool(toolPath)).resolves.toBeDefined();
		await expect(checkTool(toolPath)).rejects.toThrow(
			"TypeScript check failed",
		);
		expect(existsSync(join(directory, ".htmltool"))).toBe(false);
	});
});
