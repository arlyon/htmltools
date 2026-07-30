#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

version="${1:-$(bun -e 'console.log(require("./package.json").version)')}"
version="${version#v}"
out="$root/dist/release"
rm -rf "$out"
mkdir -p "$out"

build_archive() {
	local target="$1"
	local platform="$2"
	local executable="$3"
	local format="$4"
	local stage
	stage="$(mktemp -d)"

	bun build --compile --target="$target" src/cli.ts --outfile "$stage/$executable"
	chmod +x "$stage/$executable" 2>/dev/null || true

	if [[ "$format" == "zip" ]]; then
		(cd "$stage" && zip -q "$out/htmltool-v${version}-${platform}.zip" "$executable")
	else
		tar -C "$stage" -czf "$out/htmltool-v${version}-${platform}.tar.gz" "$executable"
	fi
	rm -rf "$stage"
}

build_archive bun-linux-x64-baseline linux-x64 htmltool tar
build_archive bun-linux-arm64 linux-arm64 htmltool tar
build_archive bun-darwin-x64-baseline macos-x64 htmltool tar
build_archive bun-darwin-arm64 macos-arm64 htmltool tar
build_archive bun-windows-x64-baseline windows-x64 htmltool.exe zip

(cd "$out" && sha256sum htmltool-* >SHA256SUMS)
printf 'Release artifacts written to %s\n' "$out"
