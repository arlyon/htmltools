#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
patch_file="$repo_root/patches/zed-htmltool-typescript.patch"

if [[ -n "${ZED_EXTENSIONS_DIR:-}" ]]; then
	extensions_root="$ZED_EXTENSIONS_DIR"
elif [[ -d "$HOME/.local/share/zed/extensions" ]]; then
	extensions_root="$HOME/.local/share/zed/extensions"
elif [[ -d "$HOME/Library/Application Support/Zed/extensions" ]]; then
	extensions_root="$HOME/Library/Application Support/Zed/extensions"
else
	printf 'Could not locate Zed extensions. Set ZED_EXTENSIONS_DIR.\n' >&2
	exit 1
fi

injections="installed/html/languages/html/injections.scm"
embedded="work/html/node_modules/@zed-industries/vscode-langservers-extracted/packages/html/lib/modes/embeddedSupport.js"
javascript="work/html/node_modules/@zed-industries/vscode-langservers-extracted/packages/html/lib/modes/javascriptMode.js"

for relative_path in "$injections" "$embedded" "$javascript"; do
	if [[ ! -f "$extensions_root/$relative_path" ]]; then
		printf 'Missing Zed runtime file: %s\n' "$extensions_root/$relative_path" >&2
		exit 1
	fi
done

if grep -q '@_lang_name' "$extensions_root/$injections" &&
	grep -q "lastAttributeName === 'lang'" "$extensions_root/$embedded" &&
	grep -q 'loadCompilerOptions(fileName)' "$extensions_root/$javascript"; then
	printf 'Zed HTML TypeScript support is already patched.\n'
	exit 0
fi

backup_root="$extensions_root/htmltool-backups/$(date +%Y%m%d-%H%M%S)"
for relative_path in "$injections" "$embedded" "$javascript"; do
	mkdir -p "$backup_root/$(dirname "$relative_path")"
	cp "$extensions_root/$relative_path" "$backup_root/$relative_path"
done

if ! patch --batch --forward --directory "$extensions_root" --strip 0 <"$patch_file"; then
	printf 'Patch failed. The Zed HTML extension likely changed; backups are in %s\n' "$backup_root" >&2
	exit 1
fi

pids="$(pgrep -f '^/usr/bin/node .*zed/extensions/work/html/.*vscode-html-language-server --stdio$' || true)"
if [[ -n "$pids" ]]; then
	kill $pids
fi

printf 'Patched Zed HTML TypeScript support. Backups: %s\n' "$backup_root"
printf 'Reopen the HTML file or restart Zed if language features do not resume automatically.\n'
