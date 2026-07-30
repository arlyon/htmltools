# Zed setup for HTMLTool

HTMLTool uses native TypeScript inside HTML:

```html
<script lang="ts" common>…</script>
<script lang="ts" server>…</script>
<script lang="ts" client>…</script>
```

Zed needs a small local patch to provide complete TypeScript language features for these blocks. HTMLTool does not ship or run a custom language server.

## Why the patch is needed

Zed's HTML extension starts `vscode-html-language-server`. That server already contains an embedded TypeScript `LanguageService`, which is why isolated code such as this has useful hover information:

```ts
const value = "hello"; // string
```

The embedded service is deliberately sandboxed, however. Its default host:

- uses classic module resolution;
- reports an empty current directory;
- exposes only the current embedded document and bundled standard libraries;
- rejects `node_modules` directories;
- suppresses unresolved-module diagnostics.

As a result, local inference works while imports such as `htmltool/server`, `node:fs`, and installed packages resolve to `any` or remain unavailable. A `package.json` or `tsconfig.json` cannot fix that until the embedded service is allowed to read the project.

Zed's Tree-sitter HTML injection also marks every script as JavaScript without checking `lang`. Tree-sitter controls parsing and highlighting; the HTML language server independently controls hover, completion, diagnostics, and definitions. Both layers need to recognize `lang="ts"`.

## Apply the patch

Inspect `patches/zed-htmltool-typescript.patch`, then run:

```bash
./scripts/patch-zed-html-typescript.sh
```

The script:

1. Locates Zed's extension directory on Linux or macOS.
2. Backs up every modified runtime file under `extensions/htmltool-backups/`.
3. Makes Tree-sitter treat `lang="ts"` blocks as combined TypeScript.
4. Makes the HTML language server recognize `lang="ts"`.
5. Gives the embedded document an adjacent virtual `.ts` path.
6. Loads the nearest `tsconfig.json`.
7. Delegates filesystem, standard-library, `@types`, and package resolution to TypeScript's normal `ts.sys` host.
8. Restarts only Zed's HTML language-server process.

Set the extension directory explicitly if Zed uses a nonstandard location:

```bash
ZED_EXTENSIONS_DIR=/path/to/zed/extensions \
  ./scripts/patch-zed-html-typescript.sh
```

## Project configuration

Keep ordinary TypeScript configuration beside the tool:

```json
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
```

Declare `htmltool`, imported packages, and ambient type packages in the nearest `package.json`, then install them with the project's package manager.

## Verify it

Open an HTMLTool file and hover `client` here:

```ts
import { createClient } from "htmltool/client";
const client = createClient<Server>();
```

Before the patch, the hover typically reports `any`. After the patch it should report:

```ts
const client: RpcClient<Server>
```

An incorrect call should also produce a normal TypeScript diagnostic using the shared contract.

## Durability and upstreaming

This modifies Zed extension runtime files, so an HTML-extension update may overwrite it. Re-run the script after an update. It exits safely if the patch is already present and refuses to continue when the upstream files no longer match.

The durable upstream fix belongs in `@zed-industries/vscode-langservers-extracted`'s HTML embedded-TypeScript host: preserve the embedded document's source location and use a project-aware TypeScript service host. The Tree-sitter `lang="ts"` recognition can be contributed separately to Zed's HTML injection query.
