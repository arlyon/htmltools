import { z } from "zod";
import type {
	McpEntry,
	RpcEntry,
	ServerDefinition,
	ServerMethod,
} from "./types.ts";

export function createServer<Contract>(
	definition: ServerDefinition<Contract>,
): ServerDefinition<Contract> {
	return definition;
}

export function rpc<Method>(run: ServerMethod<Method>): RpcEntry<Method> {
	return { kind: "rpc", run };
}

export function mcp<
	InputSchema extends z.ZodType,
	OutputSchema extends z.ZodType,
>(definition: {
	title?: string;
	description: string;
	input: InputSchema;
	output: OutputSchema;
	run: (
		input: z.output<InputSchema>,
	) => z.output<OutputSchema> | PromiseLike<z.output<OutputSchema>>;
}): McpEntry<(input: z.output<InputSchema>) => z.output<OutputSchema>> {
	return {
		kind: "mcp",
		title: definition.title,
		description: definition.description,
		input: definition.input,
		output: definition.output,
		run: definition.run,
	};
}

export { z };
