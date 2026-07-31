import { dirname, join, resolve } from "node:path";
import type { BuildArtifact } from "bun";
import ts from "typescript";
import { compileUiDocuments, type CompiledUi } from "./compile-ui.ts";
import {
	installPackageEnvironment,
	isPackageEnvironmentReady,
	resolvePackageEnvironment,
	type PackageEnvironment,
} from "./package-environment.ts";
import { parseTool, type BlockRole, type ParsedTool } from "./parse-tool.ts";

export type { CompiledUi } from "./compile-ui.ts";

export interface CompiledTool {
	parsed: ParsedTool;
	toolDirectory: string;
	clientBundle: BuildArtifact;
	serverBundle: BuildArtifact;
	ui: CompiledUi[];
}

interface VirtualEntrypoint {
	path: string;
	source: string;
}

interface PreparedTool {
	parsed: ParsedTool;
	toolDirectory: string;
	packageEnvironment?: PackageEnvironment;
	client: VirtualEntrypoint;
	appClient?: VirtualEntrypoint;
	server: VirtualEntrypoint;
}

export async function compileTool(toolPath: string): Promise<CompiledTool> {
	const prepared = await prepareTool(toolPath);
	try {
		return await compilePreparedTool(prepared);
	} catch (error) {
		if (
			!prepared.packageEnvironment ||
			isPackageEnvironmentReady(prepared.packageEnvironment)
		) {
			throw error;
		}
		await installPackageEnvironment(prepared.packageEnvironment);
		return compilePreparedTool(await prepareTool(toolPath));
	}
}

async function compilePreparedTool(
	prepared: PreparedTool,
): Promise<CompiledTool> {
	const [serverBundle, clientBundle, appClientBundle] =
		await bundleEntrypoints(prepared);
	const ui = appClientBundle
		? await compileUiDocuments(
				prepared.parsed,
				prepared.toolDirectory,
				await appClientBundle.text(),
			)
		: [];
	return {
		parsed: prepared.parsed,
		toolDirectory: prepared.toolDirectory,
		clientBundle,
		serverBundle,
		ui,
	};
}

type BundledEntrypoints = [
	server: BuildArtifact,
	client: BuildArtifact,
	appClient: BuildArtifact | undefined,
];

async function bundleEntrypoints(
	prepared: PreparedTool,
): Promise<BundledEntrypoints> {
	const [server, client, appClient] = await Promise.allSettled([
		bundleEntrypoint(prepared.server, "bun"),
		bundleEntrypoint(prepared.client, "browser"),
		prepared.appClient
			? bundleEntrypoint(prepared.appClient, "browser", {
					minify: true,
					sourcemap: "none",
				})
			: Promise.resolve(undefined),
	]);
	if (server.status === "rejected") throw server.reason;
	if (client.status === "rejected") throw client.reason;
	if (appClient.status === "rejected") throw appClient.reason;
	return [server.value, client.value, appClient.value];
}

export async function checkTool(toolPath: string): Promise<void> {
	let prepared = await prepareTool(toolPath);
	if (
		prepared.packageEnvironment &&
		!isPackageEnvironmentReady(prepared.packageEnvironment)
	) {
		await installPackageEnvironment(prepared.packageEnvironment);
		prepared = await prepareTool(toolPath);
	}
	typecheckEntrypoints(
		[prepared.server, prepared.client],
		prepared.toolDirectory,
		prepared.packageEnvironment,
	);
}

async function prepareTool(toolPath: string): Promise<PreparedTool> {
	const absoluteToolPath = resolve(toolPath);
	const toolDirectory = dirname(absoluteToolPath);
	const parsed = parseTool(await Bun.file(absoluteToolPath).text());
	const packageEnvironment = resolvePackageEnvironment(
		parsed.manifest,
		toolDirectory,
	);
	const safeName = parsed.manifest.name.replace(/[^a-zA-Z0-9._-]/g, "-");
	const entrypointDirectory =
		packageEnvironment && isPackageEnvironmentReady(packageEnvironment)
			? packageEnvironment.directory
			: toolDirectory;
	const commonSource = blockSource(parsed, "common");

	const clientSource = [commonSource, blockSource(parsed, "client")].join(
		"\n\n",
	);
	return {
		parsed,
		toolDirectory,
		packageEnvironment,
		server: {
			path: join(entrypointDirectory, `.htmltool-${safeName}.server.ts`),
			source: [commonSource, blockSource(parsed, "server")].join("\n\n"),
		},
		client: {
			path: join(entrypointDirectory, `.htmltool-${safeName}.client.ts`),
			source: clientSource,
		},
		appClient:
			parsed.ui.length === 0
				? undefined
				: {
						path: join(entrypointDirectory, `.htmltool-${safeName}.app.ts`),
						source: [
							'import { startMcpApp as __htmltoolStartMcpApp } from "htmltool/mcp-app";',
							`__htmltoolStartMcpApp(${JSON.stringify({ name: parsed.manifest.name, version: "0.3.0" })});`,
							clientSource,
						].join("\n\n"),
					},
	};
}

function blockSource(parsed: ParsedTool, role: BlockRole): string {
	return parsed.blocks
		.filter((block) => block.role === role)
		.map((block) => block.source)
		.join("\n");
}

function typecheckEntrypoints(
	entrypoints: VirtualEntrypoint[],
	toolDirectory: string,
	packageEnvironment?: PackageEnvironment,
): void {
	const compilerOptions = loadCompilerOptions(toolDirectory);
	if (packageEnvironment) {
		const existingTypeRoots =
			ts.getEffectiveTypeRoots(compilerOptions, {
				getCurrentDirectory: () => toolDirectory,
			}) ?? [];
		compilerOptions.typeRoots = [
			join(packageEnvironment.nodeModulesDirectory, "@types"),
			...existingTypeRoots,
		];
	}
	const sources = new Map(
		entrypoints.map((entrypoint) => [entrypoint.path, entrypoint.source]),
	);
	const host = ts.createCompilerHost(compilerOptions, true);
	const getSourceFile = host.getSourceFile.bind(host);
	host.fileExists = (fileName) =>
		sources.has(fileName) || ts.sys.fileExists(fileName);
	host.readFile = (fileName) =>
		sources.get(fileName) ?? ts.sys.readFile(fileName);
	host.getSourceFile = (
		fileName,
		languageVersion,
		onError,
		shouldCreateNewSourceFile,
	) => {
		const source = sources.get(fileName);
		if (source !== undefined) {
			return ts.createSourceFile(
				fileName,
				source,
				languageVersion,
				true,
				ts.ScriptKind.TS,
			);
		}
		return getSourceFile(
			fileName,
			languageVersion,
			onError,
			shouldCreateNewSourceFile,
		);
	};

	const program = ts.createProgram(
		entrypoints.map((entrypoint) => entrypoint.path),
		compilerOptions,
		host,
	);
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
	entrypoint: VirtualEntrypoint,
	target: "browser" | "bun",
	options: { minify?: boolean; sourcemap?: "inline" | "none" } = {},
): Promise<BuildArtifact> {
	let result: Awaited<ReturnType<typeof Bun.build>>;
	try {
		result = await Bun.build({
			entrypoints: [entrypoint.path],
			files: { [entrypoint.path]: entrypoint.source },
			target,
			format: "esm",
			minify: options.minify,
			sourcemap: options.sourcemap ?? "inline",
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Failed to bundle ${target} code: ${message}`, {
			cause: error,
		});
	}
	if (!result.success) {
		const details = result.logs.map((log) => log.message).join("\n");
		throw new Error(`Failed to bundle ${target} code:\n${details}`);
	}

	const output = result.outputs.find(
		(artifact) => artifact.kind === "entry-point",
	);
	if (!output) throw new Error(`Bun did not emit the ${target} entrypoint`);
	return output;
}
