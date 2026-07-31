export const instructions = String.raw`# HTMLTool authoring instructions

HTMLTool runs HTML-first local tools with Bun. A tool is one HTML file plus ordinary project files such as package.json, tsconfig.json, CSS, and assets.

## Project environment

Use the nearest package.json, node_modules, and tsconfig.json. Declare every package imported by the tool in package.json and install it with the project's configured package manager. Do not put dependencies in the HTMLTool manifest.

Recommended tsconfig.json:

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
      { "name": "hello-tool" }
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

## MCP Apps

Annotate a hyphenated custom element inside the document body with the name of an mcp(...) method to expose that fragment as the method's UI:

~~~html
<greeting-card data-htmltool-ui="greet">
  <output>Waiting…</output>
</greeting-card>
~~~

Each tool name may have one annotated custom element. HTMLTool generates a text/html;profile=mcp-app resource containing the element, bundled local assets, and the complete client bundle, then links it from the matching MCP tool. The referenced method must exist and use mcp(...). Unannotated MCP tools remain data-only.

Use native customElements.define() in the client block and perform component-specific DOM work in connectedCallback(). HTMLTool waits up to five seconds for the element to be defined and connected. It buffers official MCP input/result payloads until then and dispatches them in order as bubbling htmltool:input and htmltool:result CustomEvents. Their detail is the unchanged MCP Apps notification payload.

Existing createClient() calls work unchanged: every rpc() and mcp() method is available to the server's own MCP App through an MCP tool marked app-only, while the standalone browser uses WebSockets. AsyncIterable RPC retains pull-based streaming in either environment. App-only visibility is enforced by compliant hosts; HTMLTool's local HTTP/MCP endpoint has no authentication, so do not bind untrusted interfaces.

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
htmltool tool.html -- --tool-specific-option value
htmltool check tool.html
~~~

The browser opens by default. Startup bundles the server and browser code in memory but deliberately skips type-checking. Run htmltool check to type-check the actual common + server and common + client programs.
`;
