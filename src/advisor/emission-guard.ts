/**
 * Emission guard — the load-bearing policy gate between advisor models and
 * the primary transcript (architecture §4.3).
 *
 * normalizeAdvisorNote + CONTENT_FREE_PHRASES are copied VERBATIM from
 * oh-my-pi `packages/coding-agent/src/advisor/emission-guard.ts` (MIT,
 * same license), copied 2026-04 per ADR-009. The phrase list is domain
 * knowledge iterated in real usage (issue #3520: one session recorded 309
 * advise calls covering 92 unique notes — 114× "Stop.", 52× "No issue;
 * continue.", 41× "Done."). Do not remove this attribution.
 *
 * Intentional deviation from oh-my-pi (architecture §4.3 gate 4):
 * oh-my-pi rate-limits ALL notes to 1 per update. pi-advisor rate-limits
 * only `nit` (default 1/update, configurable); concern/blocker are
 * unlimited per update because suppressing a real blocker is worse than
 * letting two through.
 *
 * The guard is invisible to the advisor model — suppressed advise calls
 * still return "Recorded." to the tool caller. Surfacing suppression would
 * invite the model to rephrase the same note to bypass dedupe.
 */
import type { AdvisorNote, Severity } from "./types.ts";

/**
 * Case-insensitive, punctuation-folded normalization. Collapses every run of
 * non-letter / non-digit characters into a single space and trims, so
 * `"Stop."`, `"*Stop*"`, and `"  stop  "` all key to `stop`.
 */
export function normalizeAdvisorNote(note: string): string {
	return note
		.toLowerCase()
		.normalize("NFKC")
		.replace(/[^\p{L}\p{N}]+/gu, " ")
		.trim();
}

/**
 * Normalized content-free phrases. Copied from oh-my-pi (see header).
 * Conservative: only short filler with no actionable content. A genuine
 * blocker like "Stop: 'await' missing on writeStream.end() ..." does not
 * match because normalization keeps the full text.
 */
const CONTENT_FREE_PHRASES: Record<string, true> = {
	// Self-stop noise — telling the agent to "stop" without a reason is useless.
	stop: true,
	"stop here": true,
	"stop now": true,
	halt: true,
	abort: true,
	// Completion self-talk — the agent already finished the task.
	done: true,
	"task done": true,
	"task complete": true,
	complete: true,
	finished: true,
	ok: true,
	okay: true,
	"ok done": true,
	// "Nothing to flag" — silence is the correct expression of "no concerns".
	"no issue": true,
	"no issues": true,
	"no issue continue": true,
	"no concerns": true,
	"no concern": true,
	"nothing to add": true,
	"nothing to flag": true,
	"nothing to report": true,
	"no notes": true,
	"no further input": true,
	"no further input needed": true,
	"no further input required": true,
	"no further watcher input": true,
	"no further watcher input needed": true,
	"no further advice": true,
	"no further advice needed": true,
	// Endorsements — equivalent to silence.
	lgtm: true,
	"looks good": true,
	"all good": true,
	"agent is on track": true,
	"agent on track": true,
	"on track": true,
	continue: true,
	"carry on": true,
};

/** Bounds dedupe history (oh-my-pi uses 4096; pathological session had 92). */
const DEFAULT_HISTORY_CAPACITY = 4096;

/** Default per-update rate limit for nit notes. concern/blocker unlimited. */
const DEFAULT_MAX_NIT_PER_UPDATE = 1;

export interface EmissionGuardOptions {
	capacity?: number;
	maxNitPerUpdate?: number;
}

export class AdvisorEmissionGuard {
	#seen = new Set<string>();
	/** Insertion-order log driving FIFO eviction without an extra Map. */
	#seenOrder: string[] = [];
	#nitCountThisUpdate = 0;
	readonly #capacity: number;
	readonly #maxNitPerUpdate: number;

	constructor(opts: EmissionGuardOptions = {}) {
		this.#capacity = opts.capacity ?? DEFAULT_HISTORY_CAPACITY;
		this.#maxNitPerUpdate = opts.maxNitPerUpdate ?? DEFAULT_MAX_NIT_PER_UPDATE;
	}

	/**
	 * Drop all dedupe and rate-limit state. Called on advisor reset
	 * (compaction handling, /advisor reset, session switch) — same boundary
	 * as queue clear, so a re-primed advisor may re-raise old issues.
	 */
	reset(): void {
		this.#seen.clear();
		this.#seenOrder.length = 0;
		this.#nitCountThisUpdate = 0;
	}

	/** Fresh per-update nit budget. Called before each advisor prompt cycle. */
	beginUpdate(): void {
		this.#nitCountThisUpdate = 0;
	}

	/**
	 * Gate 1: the model's own `skipIf` self-declaration. If the note text
	 * satisfies the declared skip condition, drop it. The check is a plain
	 * substring match on the normalized note — skipIf strings are expected
	 * to be short normalized markers (e.g. "tests still failing").
	 *
	 * Returns true when the note should be SKIPPED.
	 */
	shouldSkip(note: AdvisorNote): boolean {
		if (!note.skipIf) return false;
		return normalizeAdvisorNote(note.note).includes(normalizeAdvisorNote(note.skipIf));
	}

	/**
	 * Gates 2–4: content-free blacklist → session dedupe → nit rate limit.
	 * On `true` the note is recorded (dedupe history + nit budget consumed);
	 * the caller delivers it. On `false` the caller drops it silently.
	 *
	 * Dedupe is keyed by advisorName + normalized text, so two different
	 * advisors may legitimately raise the same concern.
	 */
	accept(advisorName: string, note: AdvisorNote): boolean {
		const normalized = normalizeAdvisorNote(note.note);
		if (!normalized) return false;
		if (CONTENT_FREE_PHRASES[normalized]) return false;
		const key = `${advisorName} ${normalized}`;
		if (this.#seen.has(key)) return false;
		if (note.severity === "nit") {
			if (this.#nitCountThisUpdate >= this.#maxNitPerUpdate) return false;
			this.#nitCountThisUpdate++;
		}
		this.#seen.add(key);
		this.#seenOrder.push(key);
		if (this.#seenOrder.length > this.#capacity) {
			const stale = this.#seenOrder.shift();
			if (stale !== undefined) this.#seen.delete(stale);
		}
		return true;
	}

	/** Full pipeline: skipIf then accept. Convenience for the router. */
	acceptNote(advisorName: string, note: AdvisorNote): boolean {
		if (this.shouldSkip(note)) return false;
		return this.accept(advisorName, note);
	}

	/** Test/inspection hook. */
	get seenCount(): number {
		return this.#seen.size;
	}
}

export const _internals = { CONTENT_FREE_PHRASES } as const;
export type { Severity };
