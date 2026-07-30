# HTMLTool for Obsidian

A desktop-only Obsidian plugin that opens HTMLTool files as workspace panes.

## Behavior

The plugin becomes Obsidian's handler for every `.html` file in the vault.

- Files containing one valid `application/htmltool+json` manifest start an
  HTMLTool process and render its loopback URL in the pane.
- Closing the pane or navigating it to another file stops that process.
- Ordinary HTML files show a source preview and an **Open in default app** action.
- Invalid HTMLTool manifests show an error and are not executed.

Opening an HTMLTool executes its server TypeScript with the current user's
permissions. Only open tools you trust.

## Requirements

- Obsidian desktop
- An installed `htmltool` executable
- A local filesystem vault

Obsidian launched from a desktop shell may not inherit the same `PATH` as a
terminal. The plugin setting accepts either a command name or an absolute
executable path and includes a **Test** action.

## Build

```bash
cd integrations/obsidian
bun install
bun run check
```

The build writes `main.js` beside `manifest.json` and `styles.css`.

## Install

Create the plugin directory in the target vault and copy the release files:

```text
<Vault>/.obsidian/plugins/htmltool/
├── main.js
├── manifest.json
└── styles.css
```

Enable **HTMLTool** under Obsidian's community plugin settings, then configure
and test the executable path under **Settings → HTMLTool**.

## Vault context

The plugin starts each tool with:

```text
htmltool <absolute-tool-path> --no-open --port 0
```

It also sets `HTMLTOOL_VAULT` to the vault's absolute path. Tools that do not
use this environment variable are unaffected.
