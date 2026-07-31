import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(
		temporaryDirectories
			.splice(0)
			.map((directory) => rm(directory, { recursive: true, force: true })),
	);
});

describe("htmltool CLI", () => {
	test("reserves stdio stdout for MCP messages", async () => {
		const directory = await mkdtemp(join(process.cwd(), ".htmltool-cli-"));
		temporaryDirectories.push(directory);
		const toolPath = join(directory, "tool.html");
		await writeFile(
			toolPath,
			`<!doctype html>
			<script type="application/htmltool+json">{"name":"stdio-cli-test"}</script>
			<script lang="ts" common>
			interface Server { ping(): { ok: boolean } }
			</script>
			<script lang="ts" server>
			import { createServer, mcp, z } from "htmltool/server";
			console.log("server startup message");
			export default createServer<Server>({
				ping: mcp({
					description: "Ping",
					input: z.object({}),
					output: z.object({ ok: z.boolean() }),
					run: () => ({ ok: true }),
				}),
			});
			</script>
			<script lang="ts" client>document.body.textContent = "ready"</script>`,
		);
		const child = Bun.spawn(
			[process.execPath, "run", "src/cli.ts", toolPath, "--stdio"],
			{
				cwd: process.cwd(),
				stdin: "pipe",
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		child.stdin.write(
			`${JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method: "initialize",
				params: {
					protocolVersion: "2025-06-18",
					capabilities: {},
					clientInfo: { name: "cli-test", version: "1.0.0" },
				},
			})}\n`,
		);
		child.stdin.end();
		const [exitCode, stdout, stderr] = await Promise.all([
			child.exited,
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
		]);

		expect(exitCode).toBe(0);
		const lines = stdout.trim().split("\n");
		expect(lines).toHaveLength(1);
		let response: {
			id?: number;
			result?: { serverInfo?: { name?: string } };
		};
		try {
			response = JSON.parse(lines[0] ?? "null") as typeof response;
		} catch (error) {
			throw new Error("CLI wrote a non-JSON message to stdout", {
				cause: error,
			});
		}
		expect(response.id).toBe(1);
		expect(response.result?.serverInfo?.name).toBe("stdio-cli-test");
		expect(stderr).toContain("server startup message");
	});
});
