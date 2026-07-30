import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { BuildArtifact } from "bun";
import ts from "typescript";
import { parseTool, type BlockRole, type ParsedTool } from "./parse-tool.ts";

export interface CompiledTool {
	parsed: ParsedTool;
	toolDirectory: string;
	buildDirectory: string;
	clientBundle: string;
	serverBundle: string;
}

interface PreparedTool {
	parsed: ParsedTool;
	toolDirectory: string;
	buildDirectory: string;
	clientEntry: string;
	serverEntry: string;
}

export async function compileTool(
	toolPath: string,
	buildRoot?: string,
): Promise<CompiledTool> {
	const prepared = await prepareTool(toolPath, buildRoot);
	const [serverBundle, clientBundle] = await Promise.all([
		bundleEntrypoint(
			prepared.serverEntry,
			prepared.buildDirectory,
			"bun",
			"server.js",
		),
		bundleEntrypoint(
			prepared.clientEntry,
			prepared.buildDirectory,
			"browser",
			"client.js",
		),
	]);
	return {
		parsed: prepared.parsed,
		toolDirectory: prepared.toolDirectory,
		buildDirectory: prepared.buildDirectory,
		clientBundle,
		serverBundle,
	};
}

export async function checkTool(
	toolPath: string,
	buildRoot?: string,
): Promise<void> {
	const prepared = await prepareTool(toolPath, buildRoot);
	typecheckEntrypoints(
		[prepared.serverEntry, prepared.clientEntry],
		prepared.toolDirectory,
	);
}

async function prepareTool(
	toolPath: string,
	buildRoot?: string,
): Promise<PreparedTool> {
	const absoluteToolPath = resolve(toolPath);
	const toolDirectory = dirname(absoluteToolPath);
	const parsed = parseTool(await Bun.file(absoluteToolPath).text());
	const safeName = parsed.manifest.name.replace(/[^a-zA-Z0-9._-]/g, "-");
	const resolvedBuildRoot = buildRoot
		? resolve(buildRoot)
		: join(toolDirectory, ".htmltool");
	const buildDirectory = join(resolvedBuildRoot, safeName);
	const generatedDirectory = join(buildDirectory, "generated");

	await rm(buildDirectory, { recursive: true, force: true });
	await mkdir(generatedDirectory, { recursive: true });

	const commonSource = blockSource(parsed, "common");
	const serverEntry = join(generatedDirectory, "server.ts");
	const clientEntry = join(generatedDirectory, "client.ts");
	await Promise.all([
		writeFile(
			serverEntry,
			[commonSource, blockSource(parsed, "server")].join("\n\n"),
		),
		writeFile(
			clientEntry,
			[commonSource, blockSource(parsed, "client")].join("\n\n"),
		),
	]);

	return {
		parsed,
		toolDirectory,
		buildDirectory,
		clientEntry,
		serverEntry,
	};
}

function blockSource(parsed: ParsedTool, role: BlockRole): string {
	return parsed.blocks
		.filter((block) => block.role === role)
		.map((block) => block.source)
		.join("\n");
}

function typecheckEntrypoints(
	entrypoints: string[],
	toolDirectory: string,
): void {
	const compilerOptions = loadCompilerOptions(toolDirectory);
	const program = ts.createProgram(entrypoints, compilerOptions);
	const diagnostics = ts
		.getPreEmitDiagnostics(program)
		.filter(
			(diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
		);
	if (diagnostics.length === 0) return;

	throw new Error(
		`TypeScript check failed:\n${formatDiagnostics(diagnostics, toolDirectory)}`,
	);
}

function loadCompilerOptions(toolDirectory: string): ts.CompilerOptions {
	const defaults: ts.CompilerOptions = {
		target: ts.ScriptTarget.ES2023,
		module: ts.ModuleKind.ESNext,
		moduleResolution: ts.ModuleResolutionKind.Bundler,
		strict: true,
		skipLibCheck: true,
	};
	const configPath = ts.findConfigFile(
		toolDirectory,
		ts.sys.fileExists,
		"tsconfig.json",
	);
	if (!configPath) {
		return { ...defaults, noEmit: true, allowImportingTsExtensions: true };
	}

	const loaded = ts.readConfigFile(configPath, ts.sys.readFile);
	if (loaded.error) {
		throw new Error(
			`Could not read ${configPath}:\n${formatDiagnostics([loaded.error], toolDirectory)}`,
		);
	}
	const parsed = ts.parseJsonConfigFileContent(
		loaded.config,
		ts.sys,
		dirname(configPath),
	);
	const errors = parsed.errors.filter(
		(diagnostic) =>
			diagnostic.category === ts.DiagnosticCategory.Error &&
			diagnostic.code !== 18_002 &&
			diagnostic.code !== 18_003,
	);
	if (errors.length > 0) {
		throw new Error(
			`Invalid ${configPath}:\n${formatDiagnostics(errors, toolDirectory)}`,
		);
	}

	return {
		...defaults,
		...parsed.options,
		noEmit: true,
		allowImportingTsExtensions: true,
	};
}

function formatDiagnostics(
	diagnostics: readonly ts.Diagnostic[],
	currentDirectory: string,
): string {
	return ts.formatDiagnosticsWithColorAndContext(diagnostics, {
		getCanonicalFileName: (fileName) => fileName,
		getCurrentDirectory: () => currentDirectory,
		getNewLine: () => "\n",
	});
}

async function bundleEntrypoint(
	entrypoint: string,
	outdir: string,
	target: "browser" | "bun",
	basename: string,
): Promise<string> {
	try {
		const result = await Bun.build({
			entrypoints: [entrypoint],
			outdir,
			naming: basename,
			target,
			format: "esm",
			sourcemap: "linked",
		});
		if (!result.success) {
			const details = result.logs.map((log) => log.message).join("\n");
			throw new Error(`Failed to build ${basename}:\n${details}`);
		}
		return outputPath(result.outputs, basename);
	} catch (error) {
		if (!Bun.embeddedFiles.length) throw error;
		return bundleWithExternalBun(entrypoint, outdir, target, basename);
	}
}

async function bundleWithExternalBun(
	entrypoint: string,
	outdir: string,
	target: "browser" | "bun",
	basename: string,
): Promise<string> {
	const child = Bun.spawn(
		[
			"bun",
			"build",
			entrypoint,
			"--outdir",
			outdir,
			"--target",
			target,
			"--format",
			"esm",
			"--sourcemap=linked",
		],
		{ stdout: "pipe", stderr: "pipe" },
	);
	const [exitCode, stdout, stderr] = await Promise.all([
		child.exited,
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
	]);
	if (exitCode !== 0) {
		throw new Error(
			`External Bun failed to build ${basename}:\n${stderr || stdout}`,
		);
	}
	return join(outdir, basename);
}

function outputPath(
	outputs: readonly BuildArtifact[],
	basename: string,
): string {
	const output = outputs.find((artifact) =>
		artifact.path.endsWith(`/${basename}`),
	);
	if (!output) throw new Error(`Bun did not emit ${basename}`);
	return output.path;
}
