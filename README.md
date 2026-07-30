# htmltool

A Bun runner for HTML-first local tools with embedded server TypeScript, typed browser RPC, async streams, and MCP 2.0 Streamable HTTP.

## Install

HTMLTool currently requires Bun on `PATH` to transpile browser code at tool startup.

```bash
mise use -g github:arlyon/htmltools
htmltool instructions
```

## Tool environment

An HTML tool uses an ordinary package environment. `htmltool` does not install or resolve dependencies itself.

```text
open-loops/
├── index.html
├── package.json
└── bun.lock
```

```json
{
  "private": true,
  "type": "module",
  "scripts": {
    "start": "htmltool index.html"
  },
  "dependencies": {
    "htmltool": "github:arlyon/htmltools#v0.1.0",
    "yaml": "^2.9.0"
  },
  "devDependencies": {
    "@types/bun": "^1.3.10"
  }
}
```

Install and launch it like any other Bun project:

```bash
bun install
bun run start
```

The runner generates client and server entries beneath the tool directory. Bun and TypeScript therefore resolve bare imports using the tool's nearest `package.json`, `node_modules`, and `tsconfig.json`. Missing packages are reported as normal unresolved imports.

The browser opens by default. Pass `--no-open` when running headlessly:

```bash
bunx htmltool index.html --no-open
```

## Source format

A tool has a small JSON manifest and TypeScript blocks for shared contracts, server implementation, and browser code:

```html
<script type="application/htmltool+json">
  { "name": "hello" }
</script>

<script lang="ts" common>
  interface Server {
    greet(input: { name: string }): { message: string };
  }
</script>

<script lang="ts" server>
  import { createServer, rpc } from "htmltool/server";

  export default createServer<Server>({
    greet: rpc(({ name }) => ({ message: `Hello ${name}` }))
  });
</script>

<script lang="ts" client>
  import { createClient } from "htmltool/client";

  const client = createClient<Server>();
  const result = await client.greet({ name: "Ada" });
</script>
```

Run `htmltool check index.html` to type-check the real `common + server` and `common + client` programs. Normal startup skips type-checking and only transpiles the browser bundle. In-editor support uses the editor's existing HTML/TypeScript handling; no language server is bundled with the runner.

Zed needs a project-aware embedded TypeScript patch for imported types and package resolution. See [Zed setup for HTMLTool](docs/zed.md).

## Open Loops example

```bash
cd tools
bun install
bun run start -- --vault "$HOME/Documents/Obsidian Vault"
```

The UI is served at `http://127.0.0.1:7331/`, browser RPC at `/.htmltool/rpc`, and MCP Streamable HTTP at `/mcp`.
