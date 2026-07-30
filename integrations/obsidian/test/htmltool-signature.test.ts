import { describe, expect, test } from "bun:test";
import { inspectHtmlTool } from "../src/htmltool-signature.js";

describe("inspectHtmlTool", () => {
	test("recognizes an HTMLTool manifest", () => {
		expect(
			inspectHtmlTool(`
        <!doctype html>
        <script data-purpose="tool" TYPE="application/htmltool+json">
          { "name": "Open Loops" }
        </script>
      `),
		).toEqual({ kind: "tool", name: "Open Loops" });
	});

	test("leaves ordinary HTML alone", () => {
		expect(inspectHtmlTool("<main>Hello</main>")).toEqual({
			kind: "not-tool",
		});
	});

	test("ignores signatures inside HTML comments", () => {
		expect(
			inspectHtmlTool(
				'<!-- <script type="application/htmltool+json">{"name":"No"}</script> -->',
			),
		).toEqual({ kind: "not-tool" });
	});

	test("rejects malformed manifest JSON", () => {
		const result = inspectHtmlTool(
			'<script type="application/htmltool+json">{</script>',
		);
		expect(result.kind).toBe("invalid");
		if (result.kind === "invalid") {
			expect(result.message).toStartWith("Invalid manifest JSON:");
		}
	});

	test("requires a non-empty manifest name", () => {
		expect(
			inspectHtmlTool(
				'<script type="application/htmltool+json">{"name":" "}</script>',
			),
		).toEqual({
			kind: "invalid",
			message: "The manifest name must be a non-empty string.",
		});
	});

	test("rejects duplicate manifests", () => {
		const manifest =
			'<script type="application/htmltool+json">{"name":"One"}</script>';
		expect(inspectHtmlTool(`${manifest}${manifest}`)).toEqual({
			kind: "invalid",
			message: "Only one HTMLTool manifest is allowed.",
		});
	});
});
