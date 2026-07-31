import { App } from "@modelcontextprotocol/ext-apps/app-with-deps";
import SuperJSON from "superjson";
import {
	HTMLTOOL_APP_CLOSE_METHOD,
	HTMLTOOL_APP_RPC_TOOL,
} from "./app-protocol.ts";

interface McpAppOptions {
	name: string;
	version: string;
}

interface McpAppBridge {
	call(method: string, args: unknown[]): Promise<unknown>;
}

type AppWindow = Window & {
	__htmltoolMcpAppBridge?: McpAppBridge;
};

interface PendingEvent {
	type: "htmltool:input" | "htmltool:result";
	detail: unknown;
}

const MOUNT_TIMEOUT_MS = 5_000;

export function startMcpApp(options: McpAppOptions): void {
	const root = document.querySelector<HTMLElement>("[data-htmltool-ui]");
	if (!root)
		throw new Error("The MCP App is missing its data-htmltool-ui root");

	const app = new App(
		{ name: options.name, version: options.version },
		{},
		{ autoResize: true },
	);
	const pendingEvents: PendingEvent[] = [];
	let mounted = false;
	let failed = false;

	const forward = (event: PendingEvent) => {
		if (failed) return;
		if (!mounted) {
			pendingEvents.push(event);
			return;
		}
		root.dispatchEvent(
			new CustomEvent(event.type, {
				bubbles: true,
				composed: true,
				detail: event.detail,
			}),
		);
	};

	app.addEventListener("toolinput", (detail) => {
		forward({ type: "htmltool:input", detail });
	});
	app.addEventListener("toolresult", (detail) => {
		forward({ type: "htmltool:result", detail });
	});

	const appId = crypto.randomUUID();
	let connected = Promise.resolve();
	const callServerMethod = async (method: string, args: unknown[]) => {
		await connected;
		const result = await app.callServerTool({
			name: HTMLTOOL_APP_RPC_TOOL,
			arguments: {
				payload: SuperJSON.stringify({ appId, method, args }),
			},
		});
		if (result.isError) {
			throw new Error(toolErrorMessage(result.content));
		}
		const payload = result.structuredContent?.payload;
		if (typeof payload !== "string") {
			throw new TypeError("The HTMLTool RPC bridge returned an invalid result");
		}
		return SuperJSON.parse(payload);
	};
	app.onteardown = async () => {
		try {
			await callServerMethod(HTMLTOOL_APP_CLOSE_METHOD, []);
		} catch {
			// Teardown is best-effort when the server or host is already closing.
		}
		return {};
	};
	connected = app.connect();
	const bridge: McpAppBridge = { call: callServerMethod };
	(window as AppWindow).__htmltoolMcpAppBridge = bridge;

	void withTimeout(
		Promise.all([connected, customElements.whenDefined(root.localName)]),
		MOUNT_TIMEOUT_MS,
	)
		.then(async () => {
			await Promise.resolve();
			const constructor = customElements.get(root.localName);
			if (!constructor || !(root instanceof constructor) || !root.isConnected) {
				throw new Error(`${root.localName} did not connect`);
			}
			mounted = true;
			for (const event of pendingEvents.splice(0)) forward(event);
		})
		.catch((error: unknown) => {
			failed = true;
			pendingEvents.length = 0;
			const appWindow = window as AppWindow;
			if (appWindow.__htmltoolMcpAppBridge === bridge) {
				appWindow.__htmltoolMcpAppBridge = undefined;
			}
			void app.close().catch(() => {});
			showMountError(root, error);
		});
}

function withTimeout<Value>(
	promise: Promise<Value>,
	timeoutMs: number,
): Promise<Value> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(
			() =>
				reject(new Error(`custom element was not ready within ${timeoutMs}ms`)),
			timeoutMs,
		);
		promise.then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			(error: unknown) => {
				clearTimeout(timer);
				reject(error);
			},
		);
	});
}

function showMountError(root: HTMLElement, error: unknown): void {
	const message = error instanceof Error ? error.message : String(error);
	const alert = document.createElement("div");
	alert.setAttribute("role", "alert");
	alert.dataset.htmltoolMountError = "";
	alert.textContent = `Could not mount ${root.localName}: ${message}`;
	root.replaceChildren(alert);
}

function toolErrorMessage(
	content: Array<{ type: string; text?: string }>,
): string {
	const message = content.find(
		(item): item is { type: string; text: string } =>
			item.type === "text" && typeof item.text === "string",
	)?.text;
	return message ?? "The HTMLTool RPC bridge call failed";
}
