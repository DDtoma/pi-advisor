/**
 * Shared SessionEntryLike fixtures (docs/testing.md): mixed
 * user/assistant/tool/advisory entries, thinking blocks, secret-bearing
 * text — the shapes every core module must handle.
 */
import type { SessionEntryLike } from "../../src/advisor/types.ts";

export const BRANCH_BASIC: SessionEntryLike[] = [
	{
		type: "message",
		id: "e1",
		parentId: null,
		timestamp: "2026-08-24T00:00:00Z",
		message: { role: "user", content: [{ type: "text", text: "add a login endpoint" }] },
	},
	{
		type: "message",
		id: "e2",
		parentId: "e1",
		timestamp: "2026-08-24T00:00:01Z",
		message: {
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "let me plan the route…" },
				{ type: "text", text: "I'll create src/auth/login.ts" },
				{ type: "toolCall", id: "c1", name: "write", arguments: { path: "src/auth/login.ts", content: "// …" } },
			],
		},
	},
	{
		type: "message",
		id: "e3",
		parentId: "e2",
		timestamp: "2026-08-24T00:00:02Z",
		message: {
			role: "toolResult",
			toolName: "write",
			content: [{ type: "toolResult", content: [{ type: "text", text: "wrote src/auth/login.ts" }] }],
		},
	},
];

/** An advisory entry as our own injections produce it — must never be re-delivered. */
export const ADVISORY_ENTRY: SessionEntryLike = {
	type: "custom_message",
	customType: "advisory",
	id: "e4",
	parentId: "e3",
	timestamp: "2026-08-24T00:00:03Z",
	content:
		'<advisory advisor="Security" severity="concern" guidance="weigh, don\'t blindly obey">\nlogin endpoint lacks rate limiting\n</advisory>',
	display: true,
};

/** Secret-bearing entries — scrubber integration fixtures. */
export const BRANCH_WITH_SECRET: SessionEntryLike[] = [
	{
		type: "message",
		id: "s1",
		parentId: null,
		timestamp: "2026-08-24T00:01:00Z",
		message: {
			role: "assistant",
			content: [
				{ type: "text", text: `found the key in .env: sk-${"k".repeat(40)} — do not commit it` },
			],
		},
	},
];

/** Post-compaction branch: shorter, different ids — triggers cursor reset. */
export const BRANCH_COMPACTED: SessionEntryLike[] = [
	{
		type: "compaction",
		id: "c0",
		parentId: null,
		timestamp: "2026-08-24T00:02:00Z",
		summary: "Earlier: built login endpoint, fixed a rate-limiting gap.",
		firstKeptEntryId: "c1",
		tokensBefore: 50000,
	},
	{
		type: "message",
		id: "c1",
		parentId: "c0",
		timestamp: "2026-08-24T00:02:01Z",
		message: { role: "user", content: [{ type: "text", text: "now add tests" }] },
	},
];
