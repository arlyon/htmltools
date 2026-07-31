import { isAbsolute, relative, resolve } from "node:path";
import type { Readable, Writable } from "node:stream";
import {
	McpServer,
	StdioServerTransport,
	WebStandardStreamableHTTPServerTransport,
} from "@modelcontextprotocol/server";
import { createBirpc } from "birpc";
import SuperJSON from "superjson";
import { z } from "zod";
import type { CompiledTool, CompiledUi } from "./compiler/compile-tool.ts";
import {
	HTMLTOOL_APP_CLOSE_METHOD,
	HTMLTOOL_APP_RPC_TOOL,
} from "./runtime/app-protocol.ts";
import type { McpEntry, RpcEntry } from "./runtime/types.ts";

interface SocketData {
	receive?: (message: string) => void;
	close?: () => void;
}

type RpcFunctions = Record<string, (...args: unknown[]) => unknown>;
type RuntimeMethod = (...args: any[]) => any;
type RuntimeEntry = RpcEntry<RuntimeMethod> | McpEntry<RuntimeMethod>;
type RuntimeDefinition = Record<string, RuntimeEntry>;

interface AppRpcSession {
	functions: RpcFunctions;
	streams: Map<string, AsyncIterator<unknown>>;
	timeout?: ReturnType<typeof setTimeout>;
}

const MAX_APP_RPC_SESSIONS = 32;
const APP_RPC_SESSION_IDLE_MS = 5 * 60_000;
const APP_ID_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface RunningTool {
	url: URL;
	stop(): void;
}

export interface RunningStdioTool {
	stop(): Promise<void>;
}

export async function runTool(
	compiled: CompiledTool,
	options: { hostname: string; port: number },
): Promise<RunningTool> {
	const definition = await loadDefinition(compiled);
	const mcp = createMcpServer(
		compiled.parsed.manifest.name,
		definition,
		compiled.ui,
	);
	const transport = new WebStandardStreamableHTTPServerTransport({
		sessionIdGenerator: undefined,
		enableJsonResponse: true,
	});
	await mcp.server.connect(transport);
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
				return transport.handleRequest(request);
			}
			if (url.pathname === "/.htmltool/rpc") {
				if (bunServer.upgrade(request, { data: {} })) return undefined;
				return new Response("WebSocket upgrade required", { status: 426 });
			}
			if (url.pathname === "/.htmltool/client.js") {
				return new Response(compiled.clientBundle, {
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
			void mcp.close();
		},
	};
}

export async function runToolStdio(
	compiled: CompiledTool,
	streams: { stdin?: Readable; stdout?: Writable } = {},
): Promise<RunningStdioTool> {
	const definition = await loadDefinition(compiled);
	const mcp = createMcpServer(
		compiled.parsed.manifest.name,
		definition,
		compiled.ui,
	);
	const transport = new StdioServerTransport(streams.stdin, streams.stdout);
	await mcp.server.connect(transport);
	return { stop: () => mcp.close() };
}

async function loadDefinition(
	compiled: CompiledTool,
): Promise<RuntimeDefinition> {
	const moduleUrl = URL.createObjectURL(compiled.serverBundle);
	let serverModule: { default?: RuntimeDefinition };
	try {
		serverModule = (await import(moduleUrl)) as {
			default?: RuntimeDefinition;
		};
	} finally {
		URL.revokeObjectURL(moduleUrl);
	}
	if (!serverModule.default || typeof serverModule.default !== "object") {
		throw new Error(
			"The server block must default-export createServer<Server>(...)",
		);
	}
	return serverModule.default;
}

function createMcpServer(
	name: string,
	definition: RuntimeDefinition,
	ui: CompiledUi[],
): {
	server: McpServer;
	close(): Promise<void>;
} {
	const server = new McpServer({ name, version: "0.3.0" });
	for (const reservedName of [
		HTMLTOOL_APP_RPC_TOOL,
		HTMLTOOL_APP_CLOSE_METHOD,
	]) {
		if (ui.length > 0 && Object.hasOwn(definition, reservedName)) {
			throw new Error(
				`Server method ${JSON.stringify(reservedName)} is reserved for MCP App RPC`,
			);
		}
	}
	const uiByTool = new Map(ui.map((app) => [app.toolName, app]));
	for (const app of ui) {
		const entry = definition[app.toolName];
		if (!entry) {
			throw new Error(
				`data-htmltool-ui references unknown server method ${JSON.stringify(app.toolName)}`,
			);
		}
		if (entry.kind !== "mcp") {
			throw new Error(
				`data-htmltool-ui method ${JSON.stringify(app.toolName)} must use mcp(...)`,
			);
		}
		server.registerResource(
			`${app.toolName} UI`,
			app.uri,
			{
				title: entry.title ?? app.toolName,
				description: entry.description,
				mimeType: "text/html;profile=mcp-app",
			},
			async (uri) => ({
				contents: [
					{
						uri: uri.href,
						mimeType: "text/html;profile=mcp-app",
						text: app.html,
					},
				],
			}),
		);
	}

	for (const [toolName, entry] of Object.entries(definition)) {
		if (entry.kind !== "mcp") continue;
		const app = uiByTool.get(toolName);
		server.registerTool(
			toolName,
			{
				title: entry.title,
				description: entry.description,
				inputSchema: entry.input,
				outputSchema: entry.output,
				_meta: app ? { ui: { resourceUri: app.uri } } : undefined,
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

	const appSessions = new Map<string, AppRpcSession>();
	if (ui.length > 0) registerAppRpcBridge(server, definition, appSessions);

	return {
		server,
		async close() {
			await Promise.all(
				[...appSessions.values()].map((session) => {
					if (session.timeout) clearTimeout(session.timeout);
					return closeStreams(session.streams);
				}),
			);
			appSessions.clear();
			await server.close();
		},
	};
}

function registerAppRpcBridge(
	server: McpServer,
	definition: RuntimeDefinition,
	sessions: Map<string, AppRpcSession>,
): void {
	const input = z.object({ payload: z.string().max(1_000_000) });
	const output = z.object({ payload: z.string() });
	server.registerTool(
		HTMLTOOL_APP_RPC_TOOL,
		{
			title: "HTMLTool RPC bridge",
			description: "Calls this HTMLTool's server methods from its MCP App",
			inputSchema: input,
			outputSchema: output,
			_meta: { ui: { visibility: ["app"] } },
		},
		async ({ payload }) => {
			const request = SuperJSON.parse(payload);
			if (
				!isRecord(request) ||
				typeof request.appId !== "string" ||
				!APP_ID_PATTERN.test(request.appId) ||
				typeof request.method !== "string" ||
				!Array.isArray(request.args)
			) {
				throw new TypeError("Invalid HTMLTool RPC bridge request");
			}
			const response = {
				payload: SuperJSON.stringify(
					await callAppRpc(
						definition,
						sessions,
						request.appId,
						request.method,
						request.args,
					),
				),
			};
			return {
				content: [{ type: "text", text: "HTMLTool RPC call completed" }],
				structuredContent: response,
			};
		},
	);
}

async function callAppRpc(
	definition: RuntimeDefinition,
	sessions: Map<string, AppRpcSession>,
	appId: string,
	methodName: string,
	args: unknown[],
): Promise<unknown> {
	if (methodName === HTMLTOOL_APP_CLOSE_METHOD) {
		await closeAppSession(sessions, appId);
		return undefined;
	}
	let session = sessions.get(appId);
	if (!session) {
		if (!Object.hasOwn(definition, methodName)) {
			throw new Error(`Unknown HTMLTool RPC method: ${methodName}`);
		}
		if (sessions.size >= MAX_APP_RPC_SESSIONS) {
			throw new Error("HTMLTool MCP App RPC session limit reached");
		}
		const streams = new Map<string, AsyncIterator<unknown>>();
		session = { streams, functions: rpcFunctions(definition, streams) };
		sessions.set(appId, session);
	}
	touchAppSession(sessions, appId, session);
	const method = session.functions[methodName];
	if (!Object.hasOwn(session.functions, methodName) || !method) {
		throw new Error(`Unknown HTMLTool RPC method: ${methodName}`);
	}
	return method(...args);
}

async function closeAppSession(
	sessions: Map<string, AppRpcSession>,
	appId: string,
): Promise<void> {
	const session = sessions.get(appId);
	if (!session) return;
	sessions.delete(appId);
	if (session.timeout) clearTimeout(session.timeout);
	await closeStreams(session.streams);
}

function touchAppSession(
	sessions: Map<string, AppRpcSession>,
	appId: string,
	session: AppRpcSession,
): void {
	if (session.timeout) clearTimeout(session.timeout);
	session.timeout = setTimeout(() => {
		if (sessions.get(appId) !== session) return;
		sessions.delete(appId);
		void closeStreams(session.streams);
	}, APP_RPC_SESSION_IDLE_MS);
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
