export const instructions = String.raw`# HTMLTool authoring instructions

HTMLTool runs HTML-first local tools with Bun. A tool is one HTML file plus ordinary project files such as package.json, tsconfig.json, CSS, and assets.

## Package environment

For a portable single-file tool, declare every imported package in the HTMLTool manifest. The installed htmltool executable does not make imports such as "htmltool/server" or "htmltool/client" available to the tool bundle, so declare htmltool itself:

~~~html
<script type="application/htmltool+json">
  {
    "name": "hello-tool",
    "dependencies": {
      "htmltool": "github:arlyon/htmltools#v0.3.0"
    }
  }
</script>
~~~

HTMLTool first attempts to bundle without installing. If bundling fails and the embedded environment is missing, it materializes this dependency map under its content-addressed cache, invokes its embedded Bun package manager, and retries once. htmltool check installs first because type-checking requires dependency types. On Linux the default is XDG_CACHE_HOME/htmltool/environments/<hash>, falling back to ~/.cache/htmltool/environments/<hash>; set HTMLTOOL_CACHE_DIR to override the htmltool cache root. Installs disable lifecycle scripts. Pin exact versions for reproducibility. Relative file: and link: specifications resolve from the HTML file's directory; workspace: specifications are not supported in the external cache.

A tool may instead omit manifest dependencies and use an ordinary project package.json, node_modules, and tsconfig.json. With an uncached embedded manifest, HTMLTool first tries that nearest project environment; a successful bundle skips installation. If the first bundle fails, HTMLTool installs every declared package and retries in the isolated cache, which is reused on later runs. HTML-linked assets still resolve beside the HTML file. Keep TypeScript in the common, server, and client blocks for this single-file mode; use project mode when importing local TypeScript modules. Run the project's package manager before HTMLTool when using project mode. A tsconfig.json is optional; when present, HTMLTool uses the nearest one.

Recommended tsconfig.json for a project-based tool:

~~~json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2023", "DOM", "DOM.Iterable"],
    "types": ["bun", "node"],
    "strict": true,
    "noEmit": true
  }
}
~~~

## HTML structure

Use lang="ts" to mark HTMLTool TypeScript blocks. Give each block exactly one role: common, server, or client.

~~~html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Hello tool</title>
    <link rel="stylesheet" href="./tool.css">

    <script type="application/htmltool+json">
      {
        "name": "hello-tool",
        "dependencies": {
          "htmltool": "github:arlyon/htmltools#v0.3.0"
        }
      }
    </script>

    <script lang="ts" common>
      interface Server {
        greet(input: { name: string }): { message: string };
        count(input: { limit: number }): AsyncIterable<number>;
      }
    </script>

    <script lang="ts" server>
      import { createServer, mcp, rpc, z } from "htmltool/server";

      export default createServer<Server>({
        greet: mcp({
          title: "Greet someone",
          description: "Return a greeting for a name",
          input: z.object({ name: z.string() }),
          output: z.object({ message: z.string() }),
          run: ({ name }) => ({ message: "Hello " + name }),
        }),
        count: rpc(async function* ({ limit }) {
          for (let value = 1; value <= limit; value += 1) yield value;
        }),
      });
    </script>

    <script lang="ts" client>
      import { createClient } from "htmltool/client";

      const client = createClient<Server>();
      const greeting = await client.greet({ name: "Ada" });
      document.querySelector("main")!.textContent = greeting.message;

      for await (const value of client.count({ limit: 3 })) {
        console.log(value);
      }
    </script>
  </head>
  <body><main>Loading…</main></body>
</html>
~~~

## Contract rules

- Define the RPC contract as an interface in a common block.
- Import createServer, rpc, mcp, and z from "htmltool/server" in the server block.
- Default-export exactly one createServer<Server>({...}) definition.
- Wrap browser-only procedures with rpc(...).
- mcp({...}) procedures are available through both browser RPC and MCP.
- Give MCP procedures Zod input and output schemas. Import z from "htmltool/server" so Zod stays out of the browser bundle.
- Import createClient from "htmltool/client" in the client block and call createClient<Server>().
- Ordinary return values become Promise values in the browser.
- AsyncIterable return values remain AsyncIterable values and stream with pull-based backpressure.
- Server blocks may use Bun, Node APIs, the filesystem, environment variables, and installed packages.
- Common code is compiled into both server and browser programs; keep server-only values and imports out of it.

## MCP Apps / MCP UI

An MCP UI requires three connected pieces in the same HTML file:

1. An mcp({...}) server method with input and output schemas.
2. One hyphenated custom element annotated with data-htmltool-ui="<method-name>".
3. A client-block customElements.define(...) implementation for that element.

Annotate the custom element inside the document body with the name of the mcp(...) method to expose that fragment as the method's UI:

~~~html
<greeting-card data-htmltool-ui="greet">
  <output>Waiting…</output>
</greeting-card>
~~~

Each tool name may have one annotated custom element. HTMLTool generates a ui:// resource with MIME type text/html;profile=mcp-app containing the element, bundled local assets, and the complete client bundle. The matching MCP tool advertises that URI through _meta.ui.resourceUri so a compatible host can fetch and render it. The referenced method must exist and use mcp(...). Unannotated MCP tools remain data-only, and hosts without MCP Apps support can still call every MCP tool for its structured result.

Use native customElements.define() in the client block and perform component-specific DOM work in connectedCallback():

~~~ts
customElements.define("greeting-card", class extends HTMLElement {
  connectedCallback() {
    this.addEventListener("htmltool:input", (event) => {
      const input = (event as CustomEvent<{ arguments?: { name?: string } }>).detail;
      this.querySelector("output")!.textContent =
        "Greeting " + (input.arguments?.name ?? "someone") + "…";
    });

    this.addEventListener("htmltool:result", (event) => {
      const result = (event as CustomEvent<{
        content: unknown[];
        structuredContent?: { message?: string };
        isError?: boolean;
      }>).detail;
      this.querySelector("output")!.textContent =
        result.structuredContent?.message ?? "No greeting returned";
    });
  }
});
~~~

HTMLTool waits up to five seconds for the element to be defined and connected. It buffers official MCP input/result payloads until then and dispatches them in order as bubbling htmltool:input and htmltool:result CustomEvents. Input detail is the official { arguments?: Record<string, unknown> } payload. Result detail is the unchanged CallToolResult with content, optional structuredContent, and optional isError.

The initial MCP tool call launches the app and supplies its first result. After mounting, normal user interactions may call createClient() methods. Every rpc() and mcp() method is available to the server's own MCP App through an MCP tool marked app-only, while the standalone browser uses WebSockets. AsyncIterable RPC retains pull-based streaming in either environment. App-only visibility is enforced by compliant hosts; HTMLTool's local HTTP/MCP endpoint has no authentication, so do not bind untrusted interfaces.

Local stylesheet links, CSS @import and url() dependencies, images, fonts, and media are bundled as data URLs. Remote assets and ordinary script src attributes are rejected because MCP App resources run under host-controlled content security policies; put browser code in the htmltool client block. Bundles are limited to 256 assets, 10 MiB per asset, 25 MiB of source assets, and 40 MiB per generated app document.

## Serving and assets

HTMLTool removes common and server blocks before serving the page, bundles the server and client blocks in memory, and serves relative assets from the tool directory. Keep reusable CSS in normal files and link them from the HTML.

Routes:

- / — sanitized tool UI
- /.htmltool/client.js — compiled browser code
- /.htmltool/rpc — WebSocket RPC
- /mcp — MCP 2.0 Streamable HTTP

## Running

~~~sh
htmltool tool.html
htmltool tool.html --no-open
htmltool tool.html --host 127.0.0.1 --port 7331
htmltool tool.html --stdio
htmltool tool.html -- --tool-specific-option value
htmltool check tool.html
~~~

The default mode opens the standalone browser and serves MCP 2.0 Streamable HTTP at the printed /mcp URL. Startup bundles the server and browser code in memory but deliberately skips type-checking. Run htmltool check to type-check the actual common + server and common + client programs.

Use --stdio for a local process-spawned MCP server. Stdio mode starts no HTTP server or browser; stdout is reserved for JSON-RPC, console methods are redirected to stderr, and startup diagnostics go to stderr. Server code must not write directly to process.stdout. MCP tools, generated ui:// resources, htmltool:input/htmltool:result events, and createClient() calls from inside the MCP App all continue to work over the host's MCP connection. --host and --port cannot be combined with --stdio.

Configure a compatible host with an absolute tool path:

~~~json
{
  "mcpServers": {
    "hello-tool": {
      "command": "htmltool",
      "args": ["/absolute/path/to/tool.html", "--stdio"]
    }
  }
}
~~~

## Obsidian integration

The desktop-only plugin in integrations/obsidian handles .html files in a local Obsidian vault. A file with one valid application/htmltool+json manifest starts an HTMLTool child process and renders its loopback UI in an Obsidian pane; closing or navigating away from the pane stops it. Ordinary HTML is previewed rather than executed. The plugin supplies the absolute vault path through HTMLTOOL_VAULT.

Build it with bun run check inside integrations/obsidian, then copy main.js, manifest.json, and styles.css into <vault>/.obsidian/plugins/htmltool/. Enable the community plugin and configure the HTMLTool executable in its settings. Obsidian mobile cannot launch the process.
`;
