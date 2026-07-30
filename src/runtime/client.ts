import { createBirpc, type BirpcReturn } from "birpc";
import SuperJSON from "superjson";
import type { RpcClient } from "./types.ts";

type RemoteFunctions = Record<string, (...args: unknown[]) => unknown>;
type RemoteClient = BirpcReturn<RemoteFunctions>;

interface StreamDescriptor {
	$htmltoolStream: string;
}

let activeClient: object | undefined;

export function createClient<Contract extends object>(): RpcClient<Contract> {
	if (activeClient) return activeClient as RpcClient<Contract>;

	const remote = connect();
	activeClient = new Proxy(
		{},
		{
			get(_target, property) {
				if (typeof property !== "string") return undefined;
				return (...args: unknown[]) => remoteCall(remote, property, args);
			},
		},
	);
	return activeClient as RpcClient<Contract>;
}

function connect(): RemoteClient {
	const socketUrl = new URL("/.htmltool/rpc", window.location.href);
	socketUrl.protocol = socketUrl.protocol === "https:" ? "wss:" : "ws:";
	const socket = new WebSocket(socketUrl);
	const ready = new Promise<void>((resolveReady, rejectReady) => {
		socket.addEventListener("open", () => resolveReady(), { once: true });
		socket.addEventListener(
			"error",
			() =>
				rejectReady(new Error("Could not connect to the htmltool RPC server")),
			{ once: true },
		);
	});

	return createBirpc<RemoteFunctions>(
		{},
		{
			post: async (data) => {
				await ready;
				socket.send(data);
			},
			on: (listener) => {
				socket.addEventListener("message", (event) => listener(event.data));
			},
			serialize: SuperJSON.stringify,
			deserialize: SuperJSON.parse,
			timeout: 60_000,
		},
	);
}

function remoteCall(
	remote: RemoteClient,
	method: string,
	args: unknown[],
): Promise<unknown> & AsyncIterable<unknown> {
	const response = remote.$call(method, ...args);
	Object.defineProperty(response, Symbol.asyncIterator, {
		configurable: false,
		enumerable: false,
		value: () => streamIterator(remote, response),
		writable: false,
	});
	return response as Promise<unknown> & AsyncIterable<unknown>;
}

function streamIterator(
	remote: RemoteClient,
	response: Promise<unknown>,
): AsyncIterator<unknown> {
	const streamId = response.then((value) => {
		if (!isStreamDescriptor(value)) {
			throw new TypeError("This RPC method did not return an async iterable");
		}
		return value.$htmltoolStream;
	});
	let closed = false;

	return {
		async next() {
			if (closed) return { done: true, value: undefined };
			const result = await remote.$call(
				"$htmltool.stream.next",
				await streamId,
			);
			if (!isIteratorResult(result)) {
				throw new TypeError("The server returned an invalid iterator result");
			}
			if (result.done) closed = true;
			return result;
		},
		async return() {
			if (!closed) {
				closed = true;
				await remote.$call("$htmltool.stream.return", await streamId);
			}
			return { done: true, value: undefined };
		},
	};
}

function isStreamDescriptor(value: unknown): value is StreamDescriptor {
	return (
		typeof value === "object" &&
		value !== null &&
		"$htmltoolStream" in value &&
		typeof value.$htmltoolStream === "string"
	);
}

function isIteratorResult(value: unknown): value is IteratorResult<unknown> {
	return (
		typeof value === "object" &&
		value !== null &&
		"done" in value &&
		typeof value.done === "boolean"
	);
}
