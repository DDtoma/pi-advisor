import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	AdvisorEmissionGuard,
	_internals,
	normalizeAdvisorNote,
} from "../src/advisor/emission-guard.ts";
import type { AdvisorNote } from "../src/advisor/types.ts";

function note(text: string, severity: AdvisorNote["severity"] = "concern"): AdvisorNote {
	return { note: text, severity };
}

describe("normalizeAdvisorNote", () => {
	it("folds case, punctuation, and whitespace", () => {
		assert.equal(normalizeAdvisorNote("Stop."), "stop");
		assert.equal(normalizeAdvisorNote("*Stop*"), "stop");
		assert.equal(normalizeAdvisorNote("  STOP!  "), "stop");
		assert.equal(normalizeAdvisorNote("No issue; continue."), "no issue continue");
	});
	it("keeps substantive text intact", () => {
		assert.equal(
			normalizeAdvisorNote("Stop: 'await' missing on writeStream.end()"),
			"stop await missing on writestream end",
		);
	});
});

describe("phrase blacklist", () => {
	it("contains the oh-my-pi ported phrases", () => {
		const phrases = Object.keys(_internals.CONTENT_FREE_PHRASES);
		assert.equal(phrases.length, 37, `oh-my-pi list has exactly 37 phrases, got ${phrases.length}`);
		for (const p of ["stop", "done", "lgtm", "on track", "no further watcher input needed"]) {
			assert.ok(_internals.CONTENT_FREE_PHRASES[p], `missing phrase: ${p}`);
		}
	});
});

describe("AdvisorEmissionGuard", () => {
	it("accepts a substantive note", () => {
		const g = new AdvisorEmissionGuard();
		assert.equal(g.accept("sec", note("unguarded eval in src/run.ts:42")), true);
	});

	it("suppresses empty notes", () => {
		const g = new AdvisorEmissionGuard();
		assert.equal(g.accept("sec", note("   ")), false);
		assert.equal(g.accept("sec", note("...")), false);
	});

	it("suppresses every content-free phrase variant", () => {
		const g = new AdvisorEmissionGuard();
		for (const variant of ["Stop.", "stop", "STOP!", "*stop*"]) {
			assert.equal(g.accept("sec", note(variant, "blocker")), false, variant);
		}
		assert.equal(g.accept("sec", note("LGTM")), false);
		assert.equal(g.accept("sec", note("No issue; continue.")), false);
	});

	it("does NOT suppress substantive notes starting with a blacklisted word", () => {
		const g = new AdvisorEmissionGuard();
		assert.equal(
			g.accept("sec", note("Stop: unawaited promise in writer loses buffered data", "blocker")),
			true,
		);
	});

	it("dedupes exact repeats within a session", () => {
		const g = new AdvisorEmissionGuard();
		assert.equal(g.accept("sec", note("unguarded eval")), true);
		assert.equal(g.accept("sec", note("unguarded eval")), false);
		assert.equal(g.accept("sec", note("Unguarded EVAL!")), false); // normalized match
	});

	it("dedupe key is per-advisor: different advisors may raise the same note", () => {
		const g = new AdvisorEmissionGuard();
		assert.equal(g.accept("sec", note("unguarded eval")), true);
		assert.equal(g.accept("perf", note("unguarded eval")), true);
	});

	it("key separator prevents prefix collisions", () => {
		const g = new AdvisorEmissionGuard();
		assert.equal(g.accept("ab", note("c d")), true);
		assert.equal(g.accept("a", note("bc d")), true); // would collide without separator
	});

	it("rate-limits nit to 1 per update, not concern/blocker", () => {
		const g = new AdvisorEmissionGuard();
		g.beginUpdate();
		assert.equal(g.accept("sec", note("nit one", "nit")), true);
		assert.equal(g.accept("sec", note("nit two", "nit")), false);
		// Concern and blocker are unlimited within the same update.
		assert.equal(g.accept("sec", note("real concern a")), true);
		assert.equal(g.accept("sec", note("real blocker b", "blocker")), true);
	});

	it("beginUpdate restores the nit budget", () => {
		const g = new AdvisorEmissionGuard();
		g.beginUpdate();
		assert.equal(g.accept("sec", note("nit one", "nit")), true);
		g.beginUpdate();
		assert.equal(g.accept("sec", note("nit two", "nit")), true);
	});

	it("suppressed nit does not consume the nit budget", () => {
		const g = new AdvisorEmissionGuard();
		g.beginUpdate();
		assert.equal(g.accept("sec", note("ok", "nit")), false); // blacklist
		assert.equal(g.accept("sec", note("nit real", "nit")), true); // budget intact
	});

	it("skipIf gate drops matching notes before other gates", () => {
		const g = new AdvisorEmissionGuard();
		const n: AdvisorNote = {
			note: "tests still failing: 3 cases in auth.test.ts",
			severity: "concern",
			skipIf: "tests still failing",
		};
		assert.equal(g.shouldSkip(n), true);
		assert.equal(g.acceptNote("sec", n), false);
		// skipIf not matching → passes through normal gates.
		const n2: AdvisorNote = { note: "different issue entirely", severity: "concern", skipIf: "tests still failing" };
		assert.equal(g.acceptNote("sec", n2), true);
	});

	it("reset clears dedupe and nit budget", () => {
		const g = new AdvisorEmissionGuard();
		g.beginUpdate();
		g.accept("sec", note("unguarded eval"));
		g.accept("sec", note("nit x", "nit"));
		g.reset();
		assert.equal(g.seenCount, 0);
		assert.equal(g.accept("sec", note("unguarded eval")), true);
	});

	it("evicts oldest dedupe entries beyond capacity (FIFO)", () => {
		const g = new AdvisorEmissionGuard({ capacity: 3 });
		g.accept("sec", note("issue one"));
		g.accept("sec", note("issue two"));
		g.accept("sec", note("issue three"));
		g.accept("sec", note("issue four")); // evicts "issue one"
		assert.equal(g.seenCount, 3);
		assert.equal(g.accept("sec", note("issue one")), true); // re-accepted after eviction
	});

	it("configurable nit limit", () => {
		const g = new AdvisorEmissionGuard({ maxNitPerUpdate: 2 });
		g.beginUpdate();
		assert.equal(g.accept("sec", note("nit a", "nit")), true);
		assert.equal(g.accept("sec", note("nit b", "nit")), true);
		assert.equal(g.accept("sec", note("nit c", "nit")), false);
	});
});
