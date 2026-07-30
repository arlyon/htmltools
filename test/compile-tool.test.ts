import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkTool, compileTool } from "../src/compiler/compile-tool.ts";

const temporaryDirectories: string[] = [];

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
