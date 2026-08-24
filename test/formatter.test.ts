import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MAX_ENTRY_CHARS, renderDelta } from "../src/advisor/formatter.ts";
import { SecretScrubber } from "../src/advisor/secrets.ts";
import type { SessionEntryLike } from "../src/advisor/types.ts";

const scrubber = new SecretScrubber();

function userMsg(text: string): SessionEntryLike {
	return { type: "message", message: { role: "user", content: [{ type: "text", text }] } };
}
function assistantMsg(blocks: unknown[]): SessionEntryLike {
	return { type: "message", message: { role: "assistant", content: blocks } };
}
function toolResultMsg(name: string, blocks: unknown[]): SessionEntryLike {
	return { type: "message", message: { role: "toolResult", toolName: name, content: blocks } };
}

describe("formatter.renderDelta", () => {
	it("renders user messages under ### User", () => {
		const out = renderDelta([userMsg("hello world")], scrubber);
		assert.equal(out, "### User\nhello world");
	});

	it("renders assistant text under ### Assistant", () => {
		const out = renderDelta([assistantMsg([{ type: "text", text: "working on it" }])], scrubber);
		assert.equal(out, "### Assistant\nworking on it");
	});

	it("drops assistant thinking blocks (ADR-008)", () => {
		const out = renderDelta(
			[
				assistantMsg([
					{ type: "thinking", thinking: "secret reasoning" },
					{ type: "text", text: "visible" },
				]),
			],
			scrubber,
		);
		assert.equal(out, "### Assistant\nvisible");
		assert.ok(!out.includes("secret reasoning"));
	});

	it("renders tool calls as name(args) with JSON", () => {
		const out = renderDelta(
			[assistantMsg([{ type: "toolCall", name: "read", arguments: { path: "src/index.ts" } }])],
			scrubber,
		);
		assert.ok(out.includes('**Tool call:** `read({"path":"src/index.ts"})`'));
	});

	it("truncates tool call args at 500 chars", () => {
		const big = "a".repeat(1000);
		const out = renderDelta(
			[assistantMsg([{ type: "toolCall", name: "bash", arguments: { command: big } }])],
			scrubber,
		);
		const argsPart = out.match(/`bash\((.+)\)`/s)?.[1] ?? "";
		assert.ok(argsPart.length < 600, `args rendered ${argsPart.length} chars`);
		assert.ok(argsPart.endsWith("…"));
	});

	it("renders tool results under ### Tool(name)", () => {
		const out = renderDelta(
			[toolResultMsg("read", [{ type: "toolResult", content: [{ type: "text", text: "file body" }] }])],
			scrubber,
		);
		assert.equal(out, "### Tool(read)\nfile body");
	});

	it("prefixes error tool results with [error]", () => {
		const out = renderDelta(
			[toolResultMsg("bash", [{ type: "toolResult", content: "boom", isError: true }])],
			scrubber,
		);
		assert.ok(out.startsWith("### Tool(bash)\n[error] boom"));
	});

	it("truncates a single entry at 6000 chars with a tail marker", () => {
		const big = "x".repeat(MAX_ENTRY_CHARS + 500);
		const out = renderDelta([userMsg(big)], scrubber);
		assert.ok(out.length < MAX_ENTRY_CHARS + 200);
		assert.ok(out.includes("[… truncated — full entry"));
	});

	it("joins multiple entries with blank lines", () => {
		const out = renderDelta([userMsg("one"), assistantMsg([{ type: "text", text: "two" }])], scrubber);
		assert.equal(out, "### User\none\n\n### Assistant\ntwo");
	});

	it("skips entries with no renderable content", () => {
		const out = renderDelta(
			[{ type: "label", targetId: "x", label: "l" }, userMsg("real")],
			scrubber,
		);
		assert.equal(out, "### User\nreal");
	});

	it("renders compaction entries under ### System", () => {
		const out = renderDelta(
			[{ type: "compaction", summary: "we did stuff", firstKeptEntryId: "e5", tokensBefore: 1000 }],
			scrubber,
		);
		assert.ok(out.startsWith("### System\n[context compacted]"));
		assert.ok(out.includes("we did stuff"));
	});

	it("passes text through the scrubber", () => {
		const calls: string[] = [];
		const spy = {
			scrub(text: string) {
				calls.push(text);
				return text.replace("secret-value", "xxx");
			},
		};
		const out = renderDelta([userMsg("the secret-value here")], spy as unknown as SecretScrubber);
		assert.ok(calls.length > 0, "scrub called");
		assert.ok(!out.includes("secret-value"));
		assert.ok(out.includes("xxx"));
	});

	it("returns empty string for empty delta", () => {
		assert.equal(renderDelta([], scrubber), "");
	});
});
