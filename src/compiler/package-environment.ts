import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { ToolManifest } from "./parse-tool.ts";

const CACHE_FORMAT_VERSION = 1;

export interface PackageEnvironment {
	directory: string;
	nodeModulesDirectory: string;
	packageJson: string;
}

export function resolvePackageEnvironment(
	manifest: ToolManifest,
	toolDirectory: string,
): PackageEnvironment | undefined {
	if (!manifest.dependencies) return undefined;

	const dependencies = normalizeDependencies(
		manifest.dependencies,
		toolDirectory,
	);
	const fingerprint = JSON.stringify({
		cacheFormatVersion: CACHE_FORMAT_VERSION,
		dependencies,
		platform: process.platform,
		architecture: process.arch,
		bunVersion: Bun.version,
	});
	const hash = createHash("sha256").update(fingerprint).digest("hex");
	const environmentsDirectory = join(cacheRoot(), "environments");
	const directory = join(environmentsDirectory, hash);
	return {
		directory,
		nodeModulesDirectory: join(directory, "node_modules"),
		packageJson: `${JSON.stringify(
			{
				name: "htmltool-embedded-environment",
				private: true,
				type: "module",
				dependencies,
			},
			null,
			2,
		)}\n`,
	};
}

export function isPackageEnvironmentReady(
	environment: PackageEnvironment,
): boolean {
	return (
		existsSync(join(environment.directory, "package.json")) &&
		existsSync(environment.nodeModulesDirectory)
	);
}

export async function installPackageEnvironment(
	environment: PackageEnvironment,
): Promise<void> {
	if (isPackageEnvironmentReady(environment)) return;
	const environmentsDirectory = dirname(environment.directory);
	const hash = environment.directory.slice(environmentsDirectory.length + 1);
	await mkdir(environmentsDirectory, { recursive: true });
	const temporaryDirectory = join(
		environmentsDirectory,
		`.${hash}-${process.pid}-${randomUUID()}`,
	);
	await mkdir(temporaryDirectory);
	try {
		await writeFile(
			join(temporaryDirectory, "package.json"),
			environment.packageJson,
		);
		await installDependencies(temporaryDirectory);
		try {
			await rename(temporaryDirectory, environment.directory);
		} catch (error) {
			if (
				!isAlreadyExistsError(error) ||
				!isPackageEnvironmentReady(environment)
			) {
				throw error;
			}
		}
	} finally {
		await rm(temporaryDirectory, { recursive: true, force: true });
	}
}

function normalizeDependencies(
	dependencies: Record<string, string>,
	toolDirectory: string,
): Record<string, string> {
	return Object.fromEntries(
		Object.entries(dependencies).map(([name, specification]) => [
			name,
			normalizeDependencySpecification(specification, toolDirectory),
		]),
	);
}

function normalizeDependencySpecification(
	specification: string,
	toolDirectory: string,
): string {
	for (const prefix of ["file:", "link:"]) {
		if (!specification.startsWith(prefix)) continue;
		const path = specification.slice(prefix.length);
		return path.startsWith(".")
			? `${prefix}${resolve(toolDirectory, path)}`
			: specification;
	}
	return specification.startsWith(".")
		? resolve(toolDirectory, specification)
		: specification;
}

function cacheRoot(): string {
	if (process.env.HTMLTOOL_CACHE_DIR) {
		return resolve(process.env.HTMLTOOL_CACHE_DIR);
	}
	if (process.platform === "win32" && process.env.LOCALAPPDATA) {
		return join(process.env.LOCALAPPDATA, "htmltool");
	}
	if (process.platform === "darwin") {
		return join(homedir(), "Library", "Caches", "htmltool");
	}
	return join(
		process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"),
		"htmltool",
	);
}

async function installDependencies(directory: string): Promise<void> {
	const child = Bun.spawn(
		[
			process.execPath,
			"install",
			"--cwd",
			directory,
			"--ignore-scripts",
			"--no-progress",
		],
		{
			env: { ...process.env, BUN_BE_BUN: "1" },
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	const [exitCode, stdout, stderr] = await Promise.all([
		child.exited,
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
	]);
	if (exitCode === 0) return;
	const details = [stderr.trim(), stdout.trim()].filter(Boolean).join("\n");
	throw new Error(
		`Failed to install embedded dependencies${details ? `:\n${details}` : ""}`,
	);
}

function isAlreadyExistsError(error: unknown): boolean {
	return (
		error instanceof Error &&
		"code" in error &&
		(error.code === "EEXIST" || error.code === "ENOTEMPTY")
	);
}
