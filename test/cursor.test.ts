import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { emptyCursor, fingerprintEntry, isAdvisoryEntry, sliceEntries } from "../src/advisor/cursor.ts";
import type { SessionEntryLike } from "../src/advisor/types.ts";

function msg(role: string, text: string): SessionEntryLike {
	return {
		type: "message",
		id: `e-${role}-${text}`,
		message: { role, content: [{ type: "text", text }] },
	};
}

function advisory(text: string): SessionEntryLike {
	return { type: "custom_message", customType: "advisory", content: text, display: true };
}

describe("cursor", () => {
	it("empty cursor delivers everything", () => {
		const branch = [msg("user", "a"), msg("assistant", "b")];
		const out = sliceEntries(branch, emptyCursor());
		assert.equal(out.entries.length, 2);
		assert.equal(out.resetDetected, false);
		assert.equal(out.next.count, 2);
		assert.equal(out.next.fingerprints.length, 2);
	});

	it("second slice with no new entries delivers nothing", () => {
		const branch = [msg("user", "a")];
		const first = sliceEntries(branch, emptyCursor());
		const second = sliceEntries(branch, first.next);
		assert.equal(second.entries.length, 0);
		assert.equal(second.resetDetected, false);
	});

	it("delivers only new entries after growth", () => {
		const branch = [msg("user", "a"), msg("assistant", "b")];
		const first = sliceEntries(branch, emptyCursor());
		branch.push(msg("user", "c"));
		const second = sliceEntries(branch, first.next);
		assert.equal(second.entries.length, 1);
		const delivered = second.entries[0] as SessionEntryLike;
		assert.equal(delivered.message?.role, "user");
		const content = delivered.message?.content as { text?: string }[] | undefined;
		assert.equal(content?.[0]?.text, "c");
		assert.equal(second.next.count, 3);
	});

	it("compaction (shorter branch) triggers reset with full re-delivery", () => {
		const branch = [msg("user", "a"), msg("assistant", "b"), msg("user", "c")];
		const first = sliceEntries(branch, emptyCursor());
		const compacted = [msg("user", "fresh")];
		const second = sliceEntries(compacted, first.next);
		assert.equal(second.resetDetected, true);
		assert.equal(second.entries.length, 1);
		assert.equal(second.next.count, 1);
	});

	it("in-place mutation at same length triggers reset", () => {
		const branch = [msg("user", "a"), msg("assistant", "b")];
		const first = sliceEntries(branch, emptyCursor());
		const mutated = [msg("user", "a"), msg("assistant", "EDITED")];
		const second = sliceEntries(mutated, first.next);
		assert.equal(second.resetDetected, true);
		assert.equal(second.entries.length, 2);
	});

	it("advisory entries are skipped from delivery but counted", () => {
		const branch = [msg("user", "a")];
		const first = sliceEntries(branch, emptyCursor());
		branch.push(advisory("watch out"), msg("assistant", "b"));
		const second = sliceEntries(branch, first.next);
		assert.equal(second.entries.length, 1); // only the assistant message
		assert.equal(second.entries[0]?.type, "message");
		assert.equal(second.next.count, 3); // advisory counted
		assert.equal(second.next.fingerprints.length, 3);
		// Third slice delivers nothing despite the advisory sitting mid-branch.
		const third = sliceEntries(branch, second.next);
		assert.equal(third.entries.length, 0);
	});

	it("isAdvisoryEntry matches only advisory custom_message", () => {
		assert.equal(isAdvisoryEntry(advisory("x")), true);
		assert.equal(isAdvisoryEntry(msg("user", "x")), false);
		assert.equal(
			isAdvisoryEntry({ type: "custom_message", customType: "other", content: "", display: false }),
			false,
		);
	});

	it("fingerprint is stable for identical entries", () => {
		const a = msg("user", "same");
		const b = msg("user", "same");
		assert.equal(fingerprintEntry(a), fingerprintEntry(b));
	});

	it("fingerprint differs for different content", () => {
		assert.notEqual(fingerprintEntry(msg("user", "a")), fingerprintEntry(msg("user", "b")));
	});

	it("fingerprints array shorter than count is treated as mutation", () => {
		const branch = [msg("user", "a"), msg("assistant", "b")];
		const out = sliceEntries(branch, { count: 2, fingerprints: [fingerprintEntry(branch[0] as SessionEntryLike)] });
		assert.equal(out.resetDetected, true);
	});
});
