import type { z } from "zod";

export type AnyMethod = (...args: never[]) => unknown;
export type MaybePromise<Value> = Value | PromiseLike<Value>;

export type ServerMethod<Method> = Method extends (
	...args: infer Args
) => infer Result
	? (...args: Args) => MaybePromise<Result>
	: never;

export type ClientMethod<Method> = Method extends (
	...args: infer Args
) => infer Result
	? Awaited<Result> extends AsyncIterable<infer Item>
		? (...args: Args) => AsyncIterable<Item>
		: (...args: Args) => Promise<Awaited<Result>>
	: never;

declare const methodType: unique symbol;

export interface RpcEntry<Method> {
	readonly kind: "rpc";
	readonly run: ServerMethod<Method>;
	readonly [methodType]?: (method: Method) => Method;
}

export interface McpEntry<Method> {
	readonly kind: "mcp";
	readonly title?: string;
	readonly description: string;
	readonly input: z.ZodType;
	readonly output: z.ZodType;
	readonly run: ServerMethod<Method>;
	readonly [methodType]?: (method: Method) => Method;
}

export type ServerDefinition<Contract> = {
	[Name in keyof Contract]: RpcEntry<Contract[Name]> | McpEntry<Contract[Name]>;
};

export type RpcClient<Contract> = {
	[Name in keyof Contract]: ClientMethod<Contract[Name]>;
};
