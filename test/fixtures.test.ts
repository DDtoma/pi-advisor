import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { emptyCursor, sliceEntries } from "../src/advisor/cursor.ts";
import { renderDelta } from "../src/advisor/formatter.ts";
import { SecretScrubber } from "../src/advisor/secrets.ts";
import {
	ADVISORY_ENTRY,
	BRANCH_BASIC,
	BRANCH_COMPACTED,
	BRANCH_WITH_SECRET,
} from "./fixtures/branch-samples.ts";

describe("branch-samples fixtures", () => {
	it("formatter drops thinking and scrubs secrets", () => {
		const scrubber = new SecretScrubber();
		const out = renderDelta(BRANCH_BASIC, scrubber);
		assert.ok(!out.includes("let me plan"), "thinking dropped");
		assert.ok(out.includes("### Assistant"));
		assert.ok(out.includes("write("));

		const secretOut = renderDelta(BRANCH_WITH_SECRET, scrubber);
		assert.ok(!secretOut.includes("k".repeat(40)), "secret scrubbed");
	});

	it("cursor skips advisory entries but counts them", () => {
		const branch = [...BRANCH_BASIC, ADVISORY_ENTRY];
		const out = sliceEntries(branch, emptyCursor());
		assert.equal(out.next.count, 4);
		assert.equal(out.entries.length, 3, "advisory not delivered");
	});

	it("compacted branch triggers reset", () => {
		const first = sliceEntries(BRANCH_BASIC, emptyCursor());
		const second = sliceEntries(BRANCH_COMPACTED, first.next);
		assert.equal(second.resetDetected, true);
		assert.equal(second.entries.length, 2);
	});
});
