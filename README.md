# htmltool

A Bun runner for HTML-first local tools with embedded server TypeScript, typed browser RPC, async streams, and MCP 2.0 Streamable HTTP.

## Install

```bash
mise use -g github:arlyon/htmltools@0.2.0
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
    "htmltool": "github:arlyon/htmltools#v0.2.0",
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

The runner compiles virtual client and server entries entirely in memory. Their virtual paths sit beneath the tool directory, so Bun and TypeScript resolve bare imports using the nearest `package.json`, `node_modules`, and `tsconfig.json` without writing build artifacts. Missing packages are reported as normal unresolved imports.

The browser opens by default. Pass `--no-open` when running headlessly:

```bash
htmltool index.html --no-open
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

Run `htmltool check index.html` to type-check the real `common + server` and `common + client` programs. Normal startup skips type-checking and bundles both runtime programs in memory. In-editor support uses the editor's existing HTML/TypeScript handling; no language server is bundled with the runner.

## MCP Apps

An HTMLTool can expose an interactive [MCP App](https://modelcontextprotocol.io/docs/extensions/apps) without a separate frontend project. Define the launch operation as an `mcp(...)` server method:

```ts
import { createServer, mcp, z } from "htmltool/server";

export default createServer({
  greet: mcp({
    description: "Greet someone",
    input: z.object({ name: z.string() }),
    output: z.object({ message: z.string() }),
    run: ({ name }) => ({ message: `Hello ${name}` }),
  }),
});
```

Then annotate one hyphenated custom element with that method name:

```html
<greeting-card data-htmltool-ui="greet">
  <output>Waiting…</output>
</greeting-card>
```

HTMLTool packages the annotated fragment, document head styles, and client bundle as a `text/html;profile=mcp-app` resource. The matching MCP tool automatically advertises its generated `ui://` resource. Connect an MCP Apps-compatible host to the `/mcp` URL printed at startup; the model supplies tool arguments and receives structured data, while HTMLTool supplies the interface.

Define the element with the native Custom Elements API. The complete client bundle is included, but only elements present in the extracted fragment connect and mount:

```ts
customElements.define("greeting-card", class extends HTMLElement {
  connectedCallback() {
    this.addEventListener("htmltool:result", (event) => {
      const result = (event as CustomEvent).detail;
      this.render(result.structuredContent);
    });
  }

  render(value: unknown) {
    this.querySelector("output")!.textContent = JSON.stringify(value);
  }
});
```

HTMLTool buffers the official MCP input/result payloads until the element is defined and connected, then dispatches them in order as bubbling `htmltool:input` and `htmltool:result` events. An element that is not defined within five seconds displays a mounting error.

Existing `createClient()` calls also work inside the MCP App. HTMLTool transparently routes every `rpc()` and `mcp()` method through an MCP tool marked app-only, including async iterables, while the standalone browser continues using WebSockets. App-only visibility is enforced by compliant hosts; HTMLTool's local HTTP/MCP endpoint has no authentication, so do not bind untrusted interfaces.

Local stylesheets, CSS imports and URLs, images, fonts, and media are bundled as data URLs; remote assets are rejected. Bundles are limited to 256 assets, 10 MiB per asset, 25 MiB of source assets, and 40 MiB per generated app document.

Zed needs a project-aware embedded TypeScript patch for imported types and package resolution. See [Zed setup for HTMLTool](docs/zed.md).

## Obsidian plugin

The desktop-only [Obsidian integration](integrations/obsidian/README.md) makes Obsidian the file host for HTMLTool:

- Opening an `.html` file with one valid HTMLTool manifest starts `htmltool` and renders its loopback URL in an Obsidian pane.
- Closing or navigating away from the pane stops the child process.
- Ordinary HTML receives a source preview instead of being executed.
- The vault path is passed as `HTMLTOOL_VAULT`, so tools can work with vault content without hard-coded paths.

Build and install the plugin into a local vault:

```bash
cd integrations/obsidian
bun install
bun run check

plugin_dir="/path/to/vault/.obsidian/plugins/htmltool"
mkdir -p "$plugin_dir"
cp main.js manifest.json styles.css "$plugin_dir/"
```

Enable **HTMLTool** under **Settings → Community plugins**, then set and test the executable under **Settings → HTMLTool**. The plugin requires Obsidian desktop and a local filesystem vault; Obsidian mobile cannot launch the HTMLTool process.

## Open Loops example

```bash
cd tools
bun install
bun run start -- --vault "$HOME/Documents/Obsidian Vault"
```

The UI is served at `http://127.0.0.1:7331/`, browser RPC at `/.htmltool/rpc`, and MCP Streamable HTTP at `/mcp`.
