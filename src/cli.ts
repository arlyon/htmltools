#!/usr/bin/env bun
import { resolve } from "node:path";
import { checkTool, compileTool } from "./compiler/compile-tool.ts";
import { instructions } from "./instructions.ts";
import { runTool, runToolStdio } from "./runner.ts";

interface CliOptions {
	toolPath: string;
	hostname: string;
	port: number;
	openBrowser: boolean;
	stdio: boolean;
}

const help = `Usage:
  htmltool <tool.html> [OPTIONS] [-- TOOL_ARGS...]
  htmltool check <tool.html>
  htmltool instructions

Commands:
  check         Type-check common + server and common + client
  instructions  Print the complete LLM authoring guide

Options:
  --host HOST   Bind address (default: 127.0.0.1)
  --port PORT   HTTP port (default: 7331)
  --no-open     Do not open the browser
  --stdio       Serve MCP and MCP Apps over stdio only
  -h, --help    Show this help`;

async function main(): Promise<void> {
	const args = Bun.argv.slice(2);
	if (
		args.length === 1 &&
		(args[0] === "help" || args[0] === "-h" || args[0] === "--help")
	) {
		process.stdout.write(`${help}\n`);
		return;
	}
	if (
		args.length === 1 &&
		(args[0] === "instructions" || args[0] === "--instructions")
	) {
		process.stdout.write(`${instructions}\n`);
		return;
	}
	if (args[0] === "check") {
		if (args.length !== 2) {
			throw new Error("Usage: htmltool check <tool.html>");
		}
		const toolPath = resolve(args[1]);
		console.log(`Checking ${toolPath}…`);
		await checkTool(toolPath);
		console.log("Type check passed");
		return;
	}

	const options = parseArguments(args);

	if (options.stdio) redirectConsoleToStderr();
	if (options.stdio) {
		console.error(`Starting ${options.toolPath}…`);
	} else {
		console.log(`Starting ${options.toolPath}…`);
	}
	const compiled = await compileTool(options.toolPath);
	if (options.stdio) {
		await runToolStdio(compiled);
		console.error("MCP: stdio");
		return;
	}

	const running = await runTool(compiled, options);
	console.log(`UI:  ${running.url}`);
	console.log(`RPC: ${new URL("/.htmltool/rpc", running.url)}`);
	console.log(`MCP: ${new URL("/mcp", running.url)}`);

	if (options.openBrowser) openBrowser(running.url);
}

function parseArguments(args: string[]): CliOptions {
	const options: CliOptions = {
		toolPath: "",
		hostname: "127.0.0.1",
		port: 7331,
		openBrowser: true,
		stdio: false,
	};
	let networkOption: string | undefined;

	for (let index = 0; index < args.length; index += 1) {
		const argument = args[index];
		if (argument === "--no-open") {
			options.openBrowser = false;
		} else if (argument === "--stdio") {
			options.stdio = true;
			options.openBrowser = false;
		} else if (argument === "--host") {
			networkOption = argument;
			options.hostname = requiredValue(args, ++index, argument);
		} else if (argument === "--port") {
			networkOption = argument;
			const value = Number(requiredValue(args, ++index, argument));
			if (!Number.isInteger(value) || value < 0 || value > 65_535) {
				throw new Error(`Invalid port: ${value}`);
			}
			options.port = value;
		} else if (argument === "--") {
			break;
		} else if (argument.startsWith("-")) {
			if (options.toolPath) break;
			throw new Error(`Unknown option: ${argument}`);
		} else if (!options.toolPath) {
			options.toolPath = resolve(argument);
		} else {
			throw new Error(`Unexpected argument: ${argument}`);
		}
	}

	if (!options.toolPath) {
		throw new Error(help);
	}
	if (options.stdio && networkOption) {
		throw new Error(`${networkOption} cannot be combined with --stdio`);
	}
	return options;
}

function requiredValue(args: string[], index: number, option: string): string {
	const value = args[index];
	if (!value) throw new Error(`${option} requires a value`);
	return value;
}

function redirectConsoleToStderr(): void {
	const stderr = console.error.bind(console);
	console.log = stderr;
	console.info = stderr;
	console.debug = stderr;
	console.warn = stderr;
}

function openBrowser(url: URL): void {
	const command =
		process.platform === "darwin"
			? ["open", url.href]
			: process.platform === "win32"
				? ["cmd", "/c", "start", "", url.href]
				: ["xdg-open", url.href];

	const child = Bun.spawn(command, {
		stdin: "ignore",
		stdout: "ignore",
		stderr: "ignore",
	});
	child.unref();
}

main().catch((error: unknown) => {
	if (error instanceof Error) {
		console.error(error.stack ?? error.message);
	} else {
		console.error(String(error));
	}
	process.exitCode = 1;
});
