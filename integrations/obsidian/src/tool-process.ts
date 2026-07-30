import type { SpawnOptionsWithoutStdio } from "node:child_process";
import type { EventEmitter } from "node:events";
import { dirname } from "node:path";
import type { Readable } from "node:stream";

const DEFAULT_STARTUP_TIMEOUT_MS = 15_000;
const DEFAULT_CHECK_TIMEOUT_MS = 5_000;
const MAX_DIAGNOSTIC_LENGTH = 16_000;

export interface SpawnedProcess extends EventEmitter {
	stdout: Readable;
	stderr: Readable;
	kill(signal?: NodeJS.Signals): boolean;
}

export type SpawnProcess = (
	command: string,
	args: string[],
	options: SpawnOptionsWithoutStdio,
) => SpawnedProcess;

export interface StartToolOptions {
	executable: string;
	toolPath: string;
	vaultPath: string;
	startupTimeoutMs?: number;
	signal?: AbortSignal;
	spawnProcess?: SpawnProcess;
	onUnexpectedExit?: (message: string) => void;
}

export interface RunningToolServer {
	url: URL;
	stop(): void;
}

export function startToolServer(
	options: StartToolOptions,
): Promise<RunningToolServer> {
	if (options.signal?.aborted) {
		return Promise.reject(new Error("HTMLTool startup was cancelled."));
	}

	const executable = requiredExecutable(options.executable);
	const spawnProcess = options.spawnProcess ?? nodeSpawn;
	const child = spawnProcess(
		executable,
		[options.toolPath, "--no-open", "--port", "0"],
		{
			cwd: dirname(options.toolPath),
			env: {
				...process.env,
				HTMLTOOL_VAULT: options.vaultPath,
			},
			windowsHide: true,
		},
	);
	child.stdout.setEncoding("utf8");
	child.stderr.setEncoding("utf8");
	return new ToolStartup(child, options).wait();
}

class ToolStartup {
	private stdoutBuffer = "";
	private stderr = "";
	private state: "starting" | "running" | "failed" = "starting";
	private stopping = false;
	private unexpectedExitReported = false;
	private timeout: ReturnType<typeof setTimeout> | undefined;
	private resolve: ((server: RunningToolServer) => void) | undefined;
	private reject: ((error: Error) => void) | undefined;

	constructor(
		private readonly child: SpawnedProcess,
		private readonly options: StartToolOptions,
	) {}

	wait(): Promise<RunningToolServer> {
		return new Promise((resolve, reject) => {
			this.resolve = resolve;
			this.reject = reject;
			this.attach();
		});
	}

	private attach(): void {
		this.timeout = setTimeout(
			this.onTimeout,
			this.options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS,
		);
		this.child.stdout.on("data", this.onStdout);
		this.child.stderr.on("data", this.onStderr);
		this.child.once("error", this.onError);
		this.child.once("exit", this.onExit);
		this.options.signal?.addEventListener("abort", this.onAbort, {
			once: true,
		});
	}

	private readonly onStdout = (chunk: string | Buffer): void => {
		this.stdoutBuffer += chunk.toString();
		const lines = this.stdoutBuffer.split(/\r?\n/);
		this.stdoutBuffer = lines.pop() ?? "";
		for (const line of lines) {
			const result = parseUiLine(line);
			if (result.kind === "none") continue;
			if (result.kind === "invalid") {
				this.fail(new Error(result.message), "terminate");
				return;
			}
			this.succeed(result.url);
			return;
		}
	};

	private readonly onStderr = (chunk: string | Buffer): void => {
		this.stderr = appendDiagnostic(this.stderr, chunk.toString());
	};

	private readonly onError = (error: Error): void => {
		if (this.state === "running") {
			if (!this.stopping) {
				this.reportUnexpectedExit(`HTMLTool process error: ${error.message}`);
			}
			return;
		}
		this.fail(
			new Error(`Could not start HTMLTool: ${error.message}`),
			"already-stopped",
		);
	};

	private readonly onExit = (
		code: number | null,
		signal: NodeJS.Signals | null,
	): void => {
		if (this.state === "starting") {
			const detail = this.stderr.trim() || exitDescription(code, signal);
			this.fail(
				new Error(`HTMLTool exited before startup: ${detail}`),
				"already-stopped",
			);
			return;
		}
		if (this.state === "running" && !this.stopping) {
			this.reportUnexpectedExit(
				`HTMLTool stopped unexpectedly (${exitDescription(code, signal)}).`,
			);
		}
	};

	private readonly onAbort = (): void => {
		this.fail(new Error("HTMLTool startup was cancelled."), "terminate");
	};

	private readonly onTimeout = (): void => {
		this.fail(
			new Error(
				`HTMLTool did not report a UI URL within ${this.options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS} ms.`,
			),
			"terminate",
		);
	};

	private readonly stop = (): void => {
		if (this.stopping) return;
		this.stopping = true;
		this.child.kill();
	};

	private succeed(url: URL): void {
		if (this.state !== "starting") return;
		this.state = "running";
		this.cleanupStartupListeners();
		this.resolve?.({ url, stop: this.stop });
	}

	private fail(
		error: Error,
		processDisposition: "terminate" | "already-stopped",
	): void {
		if (this.state !== "starting") return;
		this.state = "failed";
		this.cleanupAllListeners();
		if (processDisposition === "terminate") this.child.kill();
		this.reject?.(error);
	}

	private cleanupStartupListeners(): void {
		if (this.timeout) clearTimeout(this.timeout);
		this.child.stdout.removeListener("data", this.onStdout);
		this.child.stderr.removeListener("data", this.onStderr);
		this.options.signal?.removeEventListener("abort", this.onAbort);
	}

	private cleanupAllListeners(): void {
		this.cleanupStartupListeners();
		this.child.removeListener("error", this.onError);
		this.child.removeListener("exit", this.onExit);
	}

	private reportUnexpectedExit(message: string): void {
		if (this.unexpectedExitReported) return;
		this.unexpectedExitReported = true;
		this.options.onUnexpectedExit?.(message);
	}
}

export async function checkExecutable(
	executable: string,
	spawnProcess: SpawnProcess = nodeSpawn,
	timeoutMs = DEFAULT_CHECK_TIMEOUT_MS,
): Promise<void> {
	const command = requiredExecutable(executable);
	const child = spawnProcess(command, ["--help"], {
		env: process.env,
		windowsHide: true,
	});
	child.stderr.setEncoding("utf8");

	await new Promise<void>((resolve, reject) => {
		let stderr = "";
		let settled = false;
		const timeout = setTimeout(() => {
			child.kill();
			finish(new Error(`HTMLTool check timed out after ${timeoutMs} ms.`));
		}, timeoutMs);

		const finish = (error?: Error): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			if (error) reject(error);
			else resolve();
		};

		child.stderr.on("data", (chunk: string | Buffer) => {
			stderr = appendDiagnostic(stderr, chunk.toString());
		});
		child.once("error", (error) => {
			finish(new Error(`Could not run HTMLTool: ${error.message}`));
		});
		child.once("exit", (code, signal) => {
			if (code === 0) {
				finish();
				return;
			}
			const detail = stderr.trim() || exitDescription(code, signal);
			finish(new Error(`HTMLTool check failed: ${detail}`));
		});
	});
}

type ParsedUiLine =
	| { kind: "none" }
	| { kind: "valid"; url: URL }
	| { kind: "invalid"; message: string };

export function parseUiLine(line: string): ParsedUiLine {
	const match = /^UI:\s+(\S+)\s*$/.exec(line);
	if (!match) return { kind: "none" };

	let url: URL;
	try {
		url = new URL(match[1]);
	} catch {
		return { kind: "invalid", message: "HTMLTool reported an invalid UI URL." };
	}

	if (url.protocol !== "http:" || !isLoopbackHost(url.hostname)) {
		return {
			kind: "invalid",
			message: "HTMLTool must report an HTTP URL on the loopback interface.",
		};
	}
	return { kind: "valid", url };
}

function isLoopbackHost(hostname: string): boolean {
	return (
		hostname === "127.0.0.1" ||
		hostname === "localhost" ||
		hostname === "[::1]" ||
		hostname === "::1"
	);
}

function requiredExecutable(executable: string): string {
	const value = executable.trim();
	if (!value) throw new Error("Configure the HTMLTool executable path first.");
	return value;
}

function appendDiagnostic(current: string, next: string): string {
	return `${current}${next}`.slice(-MAX_DIAGNOSTIC_LENGTH);
}

function exitDescription(
	code: number | null,
	signal: NodeJS.Signals | null,
): string {
	if (signal) return `signal ${signal}`;
	return `exit code ${code ?? "unknown"}`;
}

function nodeSpawn(
	command: string,
	args: string[],
	options: SpawnOptionsWithoutStdio,
): SpawnedProcess {
	const { spawn } = require("node:child_process") as typeof import("node:child_process");
	return spawn(command, args, options);
}
