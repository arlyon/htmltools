import { isAbsolute, relative, resolve } from "node:path";
import {
	McpServer,
	WebStandardStreamableHTTPServerTransport,
} from "@modelcontextprotocol/server";
import { createBirpc } from "birpc";
import SuperJSON from "superjson";
import type { McpEntry, RpcEntry } from "./runtime/types.ts";
import type { CompiledTool } from "./compiler/compile-tool.ts";

interface SocketData {
	receive?: (message: string) => void;
	close?: () => void;
}

type RpcFunctions = Record<string, (...args: unknown[]) => unknown>;
type RuntimeMethod = (...args: any[]) => any;
type RuntimeEntry = RpcEntry<RuntimeMethod> | McpEntry<RuntimeMethod>;
type RuntimeDefinition = Record<string, RuntimeEntry>;

export interface RunningTool {
	url: URL;
	stop(): void;
}

export async function runTool(
	compiled: CompiledTool,
	options: { hostname: string; port: number },
): Promise<RunningTool> {
	const moduleUrl = `${Bun.pathToFileURL(compiled.serverBundle).href}?v=${Date.now()}`;
	const serverModule = (await import(moduleUrl)) as {
		default?: RuntimeDefinition;
	};
	if (!serverModule.default || typeof serverModule.default !== "object") {
		throw new Error(
			"The server block must default-export createServer<Server>(...)",
		);
	}

	const definition = serverModule.default;
	const mcp = await createMcpEndpoint(
		compiled.parsed.manifest.name,
		definition,
	);
	const server = Bun.serve<SocketData>({
		hostname: options.hostname,
		port: options.port,
		async fetch(request, bunServer) {
			let url: URL;
			try {
				url = new URL(request.url);
			} catch {
				return new Response("Invalid request URL", { status: 400 });
			}

			if (url.pathname === "/mcp") {
				return mcp.transport.handleRequest(request);
			}
			if (url.pathname === "/.htmltool/rpc") {
				if (bunServer.upgrade(request, { data: {} })) return undefined;
				return new Response("WebSocket upgrade required", { status: 426 });
			}
			if (url.pathname === "/.htmltool/client.js") {
				return new Response(Bun.file(compiled.clientBundle), {
					headers: { "content-type": "text/javascript; charset=utf-8" },
				});
			}
			if (url.pathname === "/") {
				return new Response(compiled.parsed.browserHtml, {
					headers: {
						"content-type": "text/html; charset=utf-8",
						"cache-control": "no-store",
					},
				});
			}

			let requestedPath: string;
			try {
				requestedPath = decodeURIComponent(url.pathname).replace(/^\/+/, "");
			} catch {
				return new Response("Invalid asset path", { status: 400 });
			}
			const assetPath = resolve(compiled.toolDirectory, requestedPath);
			const relativePath = relative(compiled.toolDirectory, assetPath);
			if (
				relativePath.startsWith("..") ||
				isAbsolute(relativePath) ||
				requestedPath.startsWith(".htmltool/")
			) {
				return new Response("Forbidden", { status: 403 });
			}

			const asset = Bun.file(assetPath);
			if (!(await asset.exists()))
				return new Response("Not found", { status: 404 });
			return new Response(asset, {
				headers: {
					"content-type": asset.type || "application/octet-stream",
					"cache-control": "no-store",
				},
			});
		},
		websocket: {
			open(socket) {
				const streams = new Map<string, AsyncIterator<unknown>>();
				const functions = rpcFunctions(definition, streams);
				const channel = createBirpc<Record<string, never>, RpcFunctions>(
					functions,
					{
						post: (data) => socket.send(data),
						on: (listener) => {
							socket.data.receive = listener;
						},
						serialize: SuperJSON.stringify,
						deserialize: SuperJSON.parse,
						onFunctionError(error, method) {
							console.error(`RPC ${method} failed:`, error);
						},
					},
				);
				socket.data.close = () => {
					channel.$close();
					void closeStreams(streams);
				};
			},
			message(socket, message) {
				const text =
					typeof message === "string"
						? message
						: new TextDecoder().decode(message);
				socket.data.receive?.(text);
			},
			close(socket) {
				socket.data.close?.();
			},
		},
	});

	return {
		url: server.url,
		stop: () => {
			server.stop();
			void mcp.server.close();
		},
	};
}

async function createMcpEndpoint(
	name: string,
	definition: RuntimeDefinition,
): Promise<{
	server: McpServer;
	transport: WebStandardStreamableHTTPServerTransport;
}> {
	const server = new McpServer({ name, version: "0.0.0" });
	for (const [toolName, entry] of Object.entries(definition)) {
		if (entry.kind !== "mcp") continue;
		server.registerTool(
			toolName,
			{
				title: entry.title,
				description: entry.description,
				inputSchema: entry.input,
				outputSchema: entry.output,
			},
			async (input) => {
				const parsedInput = entry.input.parse(input);
				const output = entry.output.parse(await entry.run(parsedInput));
				if (!isRecord(output)) {
					throw new Error("MCP tool output schemas must describe an object");
				}
				return {
					content: [{ type: "text", text: JSON.stringify(output) }],
					structuredContent: output,
				};
			},
		);
	}

	const transport = new WebStandardStreamableHTTPServerTransport({
		sessionIdGenerator: undefined,
		enableJsonResponse: true,
	});
	await server.connect(transport);
	return { server, transport };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rpcFunctions(
	definition: RuntimeDefinition,
	streams: Map<string, AsyncIterator<unknown>>,
): RpcFunctions {
	const functions = Object.fromEntries(
		Object.entries(definition).map(([name, entry]) => [
			name,
			async (...args: unknown[]) => {
				const result =
					entry.kind === "mcp"
						? entry.output.parse(await entry.run(entry.input.parse(args[0])))
						: await entry.run(...args);
				if (!isAsyncIterable(result)) return result;

				const streamId = crypto.randomUUID();
				streams.set(streamId, result[Symbol.asyncIterator]());
				return { $htmltoolStream: streamId };
			},
		]),
	) as RpcFunctions;

	functions["$htmltool.stream.next"] = async (streamId: unknown) => {
		const iterator = streamForId(streams, streamId);
		const result = await iterator.next();
		if (result.done) streams.delete(streamId as string);
		return result;
	};
	functions["$htmltool.stream.return"] = async (streamId: unknown) => {
		const iterator = streamForId(streams, streamId);
		streams.delete(streamId as string);
		if (iterator.return) await iterator.return();
		return { done: true, value: undefined };
	};
	return functions;
}

function streamForId(
	streams: Map<string, AsyncIterator<unknown>>,
	streamId: unknown,
): AsyncIterator<unknown> {
	if (typeof streamId !== "string") throw new TypeError("Invalid stream ID");
	const iterator = streams.get(streamId);
	if (!iterator) throw new Error("RPC stream is closed or does not exist");
	return iterator;
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
	return (
		typeof value === "object" &&
		value !== null &&
		Symbol.asyncIterator in value &&
		typeof value[Symbol.asyncIterator] === "function"
	);
}

async function closeStreams(
	streams: Map<string, AsyncIterator<unknown>>,
): Promise<void> {
	const iterators = [...streams.values()];
	streams.clear();
	await Promise.all(iterators.map(async (iterator) => iterator.return?.()));
}
