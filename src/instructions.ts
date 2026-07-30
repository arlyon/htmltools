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

## Serving and assets

HTMLTool removes common and server blocks before serving the page, bundles the client block, and serves relative assets from the tool directory. Keep reusable CSS in normal files and link them from the HTML.

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

The browser opens by default. Startup transpiles the browser code but deliberately skips type-checking. Run htmltool check to type-check the actual common + server and common + client programs.
`;
