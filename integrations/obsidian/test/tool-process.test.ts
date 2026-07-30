import { describe, expect, test } from "bun:test";
import type { SpawnOptionsWithoutStdio } from "node:child_process";
import { EventEmitter } from "node:events";
import { dirname } from "node:path";
import { PassThrough } from "node:stream";
import {
	checkExecutable,
	parseUiLine,
	startToolServer,
	type SpawnedProcess,
	type SpawnProcess,
} from "../src/tool-process.js";

interface SpawnCall {
	command: string;
	args: string[];
	options: SpawnOptionsWithoutStdio;
}

class FakeProcess extends EventEmitter implements SpawnedProcess {
	readonly stdout = new PassThrough();
	readonly stderr = new PassThrough();
	killCount = 0;

	kill(): boolean {
		this.killCount += 1;
		return true;
	}
}

function fakeSpawner(child: FakeProcess, calls: SpawnCall[]): SpawnProcess {
	return (command, args, options) => {
		calls.push({ command, args, options });
		return child;
	};
}

describe("parseUiLine", () => {
	test("accepts loopback HTTP URLs", () => {
		const result = parseUiLine("UI:  http://127.0.0.1:45123/");
		expect(result.kind).toBe("valid");
	});

	test("rejects non-loopback URLs", () => {
		expect(parseUiLine("UI: https://example.com/")).toEqual({
			kind: "invalid",
			message: "HTMLTool must report an HTTP URL on the loopback interface.",
		});
	});
});

describe("checkExecutable", () => {
	test("runs the configured executable help command", async () => {
		const child = new FakeProcess();
		const calls: SpawnCall[] = [];
		const checking = checkExecutable(
			"/opt/bin/htmltool",
			fakeSpawner(child, calls),
		);

		child.emit("exit", 0, null);
		await checking;
		expect(calls[0].command).toBe("/opt/bin/htmltool");
		expect(calls[0].args).toEqual(["--help"]);
	});

	test("reports a failed executable check", async () => {
		const child = new FakeProcess();
		const checking = checkExecutable("htmltool", fakeSpawner(child, []));

		child.stderr.write("not executable\n");
		child.emit("exit", 1, null);
		const error = await rejectedError(checking);
		expect(error.message).toBe("HTMLTool check failed: not executable");
	});
});

describe("startToolServer", () => {
	test("starts the configured executable and returns a stoppable server", async () => {
		const child = new FakeProcess();
		const calls: SpawnCall[] = [];
		const toolPath = "/vault/tools/open-loops.html";
		const starting = startToolServer({
			executable: "/opt/bin/htmltool",
			toolPath,
			vaultPath: "/vault",
			spawnProcess: fakeSpawner(child, calls),
		});

		child.stdout.write("Starting tool…\nUI:  http://127.0.0.1:45123/\n");
		const running = await starting;

		expect(running.url.href).toBe("http://127.0.0.1:45123/");
		expect(calls).toHaveLength(1);
		expect(calls[0].command).toBe("/opt/bin/htmltool");
		expect(calls[0].args).toEqual([toolPath, "--no-open", "--port", "0"]);
		expect(calls[0].options.cwd).toBe(dirname(toolPath));
		expect(calls[0].options.env?.HTMLTOOL_VAULT).toBe("/vault");

		running.stop();
		running.stop();
		expect(child.killCount).toBe(1);
	});

	test("reports stderr when the process exits before startup", async () => {
		const child = new FakeProcess();
		const starting = startToolServer({
			executable: "htmltool",
			toolPath: "/vault/broken.html",
			vaultPath: "/vault",
			spawnProcess: fakeSpawner(child, []),
		});

		child.stderr.write("Compilation failed\n");
		child.emit("exit", 1, null);
		const error = await rejectedError(starting);
		expect(error.message).toBe(
			"HTMLTool exited before startup: Compilation failed",
		);
	});

	test("terminates a process that never reports a URL", async () => {
		const child = new FakeProcess();
		const starting = startToolServer({
			executable: "htmltool",
			toolPath: "/vault/slow.html",
			vaultPath: "/vault",
			startupTimeoutMs: 5,
			spawnProcess: fakeSpawner(child, []),
		});

		const error = await rejectedError(starting);
		expect(error.message).toBe("HTMLTool did not report a UI URL within 5 ms.");
		expect(child.killCount).toBe(1);
	});

	test("terminates startup when the caller aborts", async () => {
		const child = new FakeProcess();
		const controller = new AbortController();
		const starting = startToolServer({
			executable: "htmltool",
			toolPath: "/vault/tool.html",
			vaultPath: "/vault",
			signal: controller.signal,
			spawnProcess: fakeSpawner(child, []),
		});

		controller.abort();
		const error = await rejectedError(starting);
		expect(error.message).toBe("HTMLTool startup was cancelled.");
		expect(child.killCount).toBe(1);
	});

	test("reports an unexpected exit after startup", async () => {
		const child = new FakeProcess();
		let exitMessage = "";
		const starting = startToolServer({
			executable: "htmltool",
			toolPath: "/vault/tool.html",
			vaultPath: "/vault",
			spawnProcess: fakeSpawner(child, []),
			onUnexpectedExit: (message) => {
				exitMessage = message;
			},
		});

		child.stdout.write("UI:  http://localhost:7777/\n");
		await starting;
		child.emit("exit", 2, null);
		expect(exitMessage).toBe("HTMLTool stopped unexpectedly (exit code 2).");
	});
});

async function rejectedError(promise: Promise<unknown>): Promise<Error> {
	try {
		await promise;
	} catch (error) {
		if (error instanceof Error) return error;
		throw new Error(`Expected an Error rejection, received ${String(error)}`);
	}
	throw new Error("Expected promise to reject.");
}
