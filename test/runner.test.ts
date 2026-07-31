import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import SuperJSON from "superjson";
import { checkTool, compileTool } from "../src/compiler/compile-tool.ts";
import {
	runTool,
	runToolStdio,
	type RunningStdioTool,
	type RunningTool,
} from "../src/runner.ts";
import { HTMLTOOL_APP_CLOSE_METHOD } from "../src/runtime/app-protocol.ts";

const temporaryDirectories: string[] = [];
const runningTools: RunningTool[] = [];
const runningStdioTools: RunningStdioTool[] = [];
setDefaultTimeout(60_000);
const APP_ID = "00000000-0000-4000-8000-000000000001";

interface McpToolsResult {
	tools: unknown;
}

interface McpResourceResult {
	contents: Array<{ mimeType?: string; text?: string }>;
}

interface McpToolResult {
	content?: Array<{ type: string; text?: string }>;
	isError?: boolean;
	structuredContent?: Record<string, unknown>;
}

interface NamedValue extends Record<string, unknown> {
	name: string;
	_meta?: unknown;
}

afterEach(async () => {
	for (const tool of runningTools.splice(0)) tool.stop();
	await Promise.all(runningStdioTools.splice(0).map((tool) => tool.stop()));
	await Promise.all(
		temporaryDirectories
			.splice(0)
			.map((directory) => rm(directory, { recursive: true, force: true })),
	);
});

describe("MCP Apps", () => {
	test("links annotated tools to generated UI resources and app-only RPC", async () => {
		const toolPath = await writeTool(`
			<p>Browser-only content</p>
			<inspect-view data-htmltool-ui="inspect"><output>Waiting</output></inspect-view>
		`);
		const compiled = await compileTool(toolPath);
		const running = await runTool(compiled, { hostname: "127.0.0.1", port: 0 });
		runningTools.push(running);
		const mcpUrl = new URL("/mcp", running.url);

		await mcpRequest<Record<string, unknown>>(mcpUrl, "initialize", {
			protocolVersion: "2025-06-18",
			capabilities: {},
			clientInfo: { name: "htmltool-test", version: "1.0.0" },
		});
		const tools = await mcpRequest<McpToolsResult>(mcpUrl, "tools/list", {});
		const inspect = findByName(tools.tools, "inspect");
		expect(inspect._meta).toEqual({
			ui: { resourceUri: "ui://htmltool/runner-test/inspect.html" },
		});
		const bridge = findByName(tools.tools, "htmltool_rpc");
		expect(bridge._meta).toEqual({ ui: { visibility: ["app"] } });

		const resource = await mcpRequest<McpResourceResult>(
			mcpUrl,
			"resources/read",
			{
				uri: "ui://htmltool/runner-test/inspect.html",
			},
		);
		expect(resource.contents[0]?.mimeType).toBe("text/html;profile=mcp-app");
		expect(resource.contents[0]?.text).toContain(
			'<inspect-view data-htmltool-ui="inspect"><output>Waiting</output></inspect-view>',
		);
		expect(resource.contents[0]?.text).not.toContain("Browser-only content");

		const toolResult = await mcpRequest<McpToolResult>(mcpUrl, "tools/call", {
			name: "inspect",
			arguments: { value: "model" },
		});
		expect(toolResult.structuredContent).toEqual({ value: "MODEL" });

		expect(await bridgeRequest(mcpUrl, "echoRpc", [{ value: "app" }])).toEqual({
			value: "app",
		});
		expect(await bridgeRequest(mcpUrl, "inspect", [{ value: "app" }])).toEqual({
			value: "APP",
		});

		const stream = await bridgeRequest(mcpUrl, "streamRpc", [{ limit: 2 }]);
		expect(stream).toEqual({ $htmltoolStream: expect.any(String) });
		const streamId = (stream as { $htmltoolStream: string }).$htmltoolStream;
		expect(
			await bridgeRequest(mcpUrl, "$htmltool.stream.next", [streamId]),
		).toEqual({ done: false, value: 1 });
		expect(
			await bridgeRequest(mcpUrl, "$htmltool.stream.next", [streamId]),
		).toEqual({ done: false, value: 2 });
		expect(
			await bridgeRequest(mcpUrl, "$htmltool.stream.next", [streamId]),
		).toEqual({ done: true, value: undefined });

		const abandoned = (await bridgeRequest(mcpUrl, "streamRpc", [
			{ limit: 5 },
		])) as { $htmltoolStream: string };
		await bridgeRequest(mcpUrl, HTMLTOOL_APP_CLOSE_METHOD, []);
		await expect(
			bridgeRequest(mcpUrl, "$htmltool.stream.next", [
				abandoned.$htmltoolStream,
			]),
		).rejects.toThrow("Unknown HTMLTool RPC method");
	});

	test("serves embedded-package tools and MCP App resources over stdio", async () => {
		const toolPath = await writeTool(
			'<inspect-view data-htmltool-ui="inspect"><output>Waiting</output></inspect-view>',
			{ dependencies: { htmltool: `file:${process.cwd()}` } },
		);
		const previousCacheDirectory = process.env.HTMLTOOL_CACHE_DIR;
		process.env.HTMLTOOL_CACHE_DIR = join(dirname(toolPath), "cache");
		let compiled: Awaited<ReturnType<typeof compileTool>>;
		try {
			await checkTool(toolPath);
			compiled = await compileTool(toolPath);
		} finally {
			if (previousCacheDirectory === undefined) {
				Reflect.deleteProperty(process.env, "HTMLTOOL_CACHE_DIR");
			} else {
				process.env.HTMLTOOL_CACHE_DIR = previousCacheDirectory;
			}
		}
		const input = new PassThrough();
		const output = new PassThrough();
		const client = createStdioClient(input, output);
		const running = await runToolStdio(compiled, {
			stdin: input,
			stdout: output,
		});
		runningStdioTools.push(running);

		await client.request("initialize", {
			protocolVersion: "2025-06-18",
			capabilities: {},
			clientInfo: { name: "htmltool-stdio-test", version: "1.0.0" },
		});
		const tools = await client.request<McpToolsResult>("tools/list", {});
		expect(findByName(tools.tools, "inspect")._meta).toEqual({
			ui: { resourceUri: "ui://htmltool/runner-test/inspect.html" },
		});
		const resource = await client.request<McpResourceResult>("resources/read", {
			uri: "ui://htmltool/runner-test/inspect.html",
		});
		expect(resource.contents[0]?.mimeType).toBe("text/html;profile=mcp-app");
		expect(resource.contents[0]?.text).toContain(
			'<inspect-view data-htmltool-ui="inspect"><output>Waiting</output></inspect-view>',
		);
		const toolResult = await client.request<McpToolResult>("tools/call", {
			name: "inspect",
			arguments: { value: "stdio" },
		});
		expect(toolResult.structuredContent).toEqual({ value: "STDIO" });
		const bridgeResult = await client.request<McpToolResult>("tools/call", {
			name: "htmltool_rpc",
			arguments: {
				payload: SuperJSON.stringify({
					appId: APP_ID,
					method: "echoRpc",
					args: [{ value: "app-stdio" }],
				}),
			},
		});
		const bridgePayload = bridgeResult.structuredContent?.payload;
		if (typeof bridgePayload !== "string") {
			throw new TypeError("Missing stdio bridge payload");
		}
		const bridgeOutput: unknown = SuperJSON.parse(bridgePayload);
		expect(bridgeOutput).toEqual({ value: "app-stdio" });
	});

	test("reserves the internal app RPC tool name", async () => {
		const toolPath = await writeTool(
			'<inspect-view data-htmltool-ui="inspect">Inspect</inspect-view>',
			{
				contract: "htmltool_rpc(): { ok: boolean };",
				definition: "htmltool_rpc: rpc(() => ({ ok: true })),",
			},
		);
		const compiled = await compileTool(toolPath);

		await expect(
			runTool(compiled, { hostname: "127.0.0.1", port: 0 }),
		).rejects.toThrow('Server method "htmltool_rpc" is reserved');
	});

	test("rejects UI annotations that target plain RPC methods", async () => {
		const toolPath = await writeTool(
			'<rpc-view data-htmltool-ui="echoRpc">RPC</rpc-view>',
		);
		const compiled = await compileTool(toolPath);

		await expect(
			runTool(compiled, { hostname: "127.0.0.1", port: 0 }),
		).rejects.toThrow('method "echoRpc" must use mcp(...)');
	});
});

function createStdioClient(
	input: PassThrough,
	output: PassThrough,
): {
	request<Result>(method: string, params: unknown): Promise<Result>;
} {
	let nextId = 1;
	let buffered = "";
	const pending = new Map<
		number,
		{ resolve(value: unknown): void; reject(error: Error): void }
	>();
	output.setEncoding("utf8");
	output.on("data", (chunk: string) => {
		buffered += chunk;
		let newline = buffered.indexOf("\n");
		while (newline >= 0) {
			const line = buffered.slice(0, newline);
			buffered = buffered.slice(newline + 1);
			if (line) {
				let message: {
					id?: number;
					result?: unknown;
					error?: { message?: string };
				};
				try {
					message = JSON.parse(line) as typeof message;
				} catch (error) {
					const parseError = new Error("Invalid MCP stdio response", {
						cause: error,
					});
					for (const waiter of pending.values()) waiter.reject(parseError);
					pending.clear();
					continue;
				}
				if (message.id !== undefined) {
					const waiter = pending.get(message.id);
					pending.delete(message.id);
					if (message.error) {
						waiter?.reject(new Error(message.error.message ?? "MCP error"));
					} else {
						waiter?.resolve(message.result);
					}
				}
			}
			newline = buffered.indexOf("\n");
		}
	});
	return {
		request<Result>(method: string, params: unknown): Promise<Result> {
			const id = nextId++;
			const result = new Promise<Result>((resolve, reject) => {
				pending.set(id, {
					resolve: (value) => resolve(value as Result),
					reject,
				});
			});
			input.write(
				`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`,
			);
			return result;
		},
	};
}

async function writeTool(
	body: string,
	extra: {
		contract?: string;
		definition?: string;
		dependencies?: Record<string, string>;
	} = {},
): Promise<string> {
	const directory = await mkdtemp(join(process.cwd(), ".htmltool-runner-"));
	temporaryDirectories.push(directory);
	const toolPath = join(directory, "index.html");
	await writeFile(
		toolPath,
		`<!doctype html>
		<html><head>
		<script type="application/htmltool+json">${JSON.stringify({
			name: "runner-test",
			...(extra.dependencies ? { dependencies: extra.dependencies } : {}),
		})}</script>
		<script lang="ts" common>
		interface Server {
			inspect(input: { value: string }): { value: string };
			echoRpc(input: { value: string }): { value: string };
			streamRpc(input: { limit: number }): AsyncIterable<number>;
			${extra.contract ?? ""}
		}
		</script>
		<script lang="ts" server>
		import { createServer, mcp, rpc, z } from "htmltool/server";
		export default createServer<Server>({
			inspect: mcp({
				description: "Inspect a value",
				input: z.object({ value: z.string() }),
				output: z.object({ value: z.string() }),
				run: ({ value }) => ({ value: value.toUpperCase() }),
			}),
			echoRpc: rpc(({ value }) => ({ value })),
			streamRpc: rpc(async function* ({ limit }) {
				for (let value = 1; value <= limit; value += 1) yield value;
			}),
			${extra.definition ?? ""}
		});
		</script>
		<script lang="ts" client>
		import { createClient } from "htmltool/client";
		const client = createClient<Server>();
		customElements.define("inspect-view", class extends HTMLElement {});
		void client.echoRpc({ value: "browser" });
		</script>
		</head><body>${body}</body></html>`,
	);
	return toolPath;
}

async function bridgeRequest(
	url: URL,
	method: string,
	args: unknown[],
): Promise<unknown> {
	const result = await mcpRequest<McpToolResult>(url, "tools/call", {
		name: "htmltool_rpc",
		arguments: {
			payload: SuperJSON.stringify({ appId: APP_ID, method, args }),
		},
	});
	if (result.isError) {
		const message = result.content?.find(
			(item) => item.type === "text" && typeof item.text === "string",
		)?.text;
		throw new Error(message ?? "HTMLTool RPC bridge failed");
	}
	const payload = result.structuredContent?.payload;
	if (typeof payload !== "string") {
		throw new TypeError("Expected an HTMLTool RPC bridge payload");
	}
	return SuperJSON.parse<unknown>(payload);
}

let requestId = 0;
async function mcpRequest<Result extends object>(
	url: URL,
	method: string,
	params: Record<string, unknown>,
): Promise<Result> {
	const response = await fetch(url, {
		method: "POST",
		headers: {
			accept: "application/json, text/event-stream",
			"content-type": "application/json",
		},
		body: JSON.stringify({
			jsonrpc: "2.0",
			id: ++requestId,
			method,
			params,
		}),
	});
	const payload = (await response.json()) as {
		result?: Result;
		error?: { message?: string };
	};
	if (!response.ok || payload.error || payload.result === undefined) {
		throw new Error(
			payload.error?.message ?? `MCP request failed: ${response.status}`,
		);
	}
	return payload.result;
}

function findByName(values: unknown, name: string): NamedValue {
	if (!Array.isArray(values)) throw new TypeError("Expected an array");
	const value = values.find(
		(candidate) =>
			typeof candidate === "object" &&
			candidate !== null &&
			"name" in candidate &&
			candidate.name === name,
	);
	if (!value || typeof value !== "object") {
		throw new Error(`Could not find ${name}`);
	}
	return value as NamedValue;
}
