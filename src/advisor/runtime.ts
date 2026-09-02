/**
 * AdvisorRuntime — the state machine at the heart of the watchdog
 * (architecture §3.1 sequence, §3.3 failure taxonomy, §4 caches).
 *
 * Per advisor instance: delta queue, single-flight drain lock, revision
 * (context reset generation), epoch (external reset generation), failure
 * counters, halt latch, cross-turn history, char budget (maxTokens × 3.5).
 * One shared AdvisorEmissionGuard across all advisors (dedupe keys include
 * the advisor name).
 *
 * Hard rule (failure containment): NO exception may escape a drain loop.
 * Every failure is classified → back off / degrade / halt, and the
 * primary agent is never touched by advisor-side errors.
 */
import { emptyCursor } from "./cursor.ts";
import { AdvisorEmissionGuard } from "./emission-guard.ts";
import { ADVISE_TOOL_DEF, runWithTools } from "./engine.ts";
import { renderDelta } from "./formatter.ts";
import { routeNote } from "./router.ts";
import { SecretScrubber } from "./secrets.ts";
import { createReadonlyToolExecutor, matchGlob, toolDefsFor } from "./tools.ts";
import type {
	AdvisorConfig,
	CompleteRequest,
	Cursor,
	DeltaSource,
	FailureClass,
	Injector,
	Message,
	ModelCaller,
	PendingDelta,
	SessionEntryLike,
	UsageTotals,
} from "./types.ts";

export const CHARS_PER_TOKEN = 3.5;
const SUMMARY_TARGET_CHARS = 2000;
const DEFAULT_MAX_CONSECUTIVE_FAILURES = 3;
const BACKOFF_BASE_MS = 1000;
const BACKOFF_CAP_MS = 60_000;
const PRIORITY_RANK: Record<string, number> = { high: 0, normal: 1, low: 2 };

export interface AdvisorRuntimeOptions {
	source: DeltaSource;
	caller: ModelCaller;
	injector: Injector;
	cwd: string;
	maxConsecutiveFailures?: number;
	/** Injected for tests; defaults to setTimeout-backed sleep. */
	sleep?: (ms: number) => Promise<void>;
	/**
	 * Optional lifecycle observer. Receives one line per notable event
	 * (queued / skipped / reviewing / silent / injected / failed) so the
	 * glue layer can surface trigger activity in debug mode. Must be
	 * cheap and must never throw — it is fire-and-forget.
	 */
	onEvent?: (slug: string, message: string) => void;
}

export interface AdvisorStatus {
	slug: string;
	name: string;
	enabled: boolean;
	halted: boolean;
	queued: number;
	draining: boolean;
	consecutiveFailures: number;
	revision: number;
	historyChars: number;
	charBudget: number;
	usage: UsageTotals;
}

interface AdvisorInstance {
	config: AdvisorConfig;
	cursor: Cursor;
	queue: PendingDelta[];
	draining: boolean;
	revision: number;
	epoch: number;
	consecutiveFailures: number;
	halted: boolean;
	history: Message[];
	usage: UsageTotals;
	turnsSinceTrigger: number;
	classifierRetried: boolean;
	contextEscalation: "none" | "summarized" | "reset";
	pendingKick: boolean;
	scrubber: SecretScrubber;
}

// ─────────────────────────── failure classification ───────────────────────────

/** Heuristic classifier over provider/model errors (architecture §3.3). */
export function classifyFailure(err: unknown): FailureClass {
	const e = err as { status?: number; code?: string; name?: string; message?: string };
	const status = typeof e?.status === "number" ? e.status : undefined;
	const msg = String(e?.message ?? err ?? "");
	const name = String(e?.name ?? "");

	if (status === 401 || status === 403 || /invalid api key|model not found|does not exist|permission/i.test(msg)) {
		return "provider_permanent";
	}
	if (/context.{0,30}(overflow|length|too long|exceed)|maximum context|prompt is too long/i.test(msg)) {
		return "advisor_context";
	}
	if (/content.?filter|classifier|safety|refused to (generate|complete)/i.test(msg)) {
		return "classifier_refusal";
	}
	if (name === "AbortError" || name === "TimeoutError" || /timed? ?out|deadline exceeded/i.test(msg)) {
		return "timeout";
	}
	// 429 / 5xx / network — and the safe default: anything unrecognized is
	// treated as transient so it gets backoff rather than a halt.
	return "provider_transient";
}

// ─────────────────────────── focus matching (§5.3) ───────────────────────────

// Path-shaped token: one or more dir segments + a final segment. The prefix
// class includes backticks because agent text almost always quotes paths
// in markdown (e.g. `src/advisor/runtime.ts`).
const PATH_TOKEN_RE = /(?:^|[\s"'`])((?:[\w@.-]+\/)+[\w.*@-]+)/g;
// Absolute path token (POSIX). Matches inside text/commands; URLs degrade to
// their path component, which then fails the workspace check and is dropped.
const ABS_PATH_RE = /(?:^|[\s"'`])(\/(?:[\w@.-]+\/)*[\w@.*-]+)/g;

/**
 * Normalize a raw path token into a workspace-relative hint.
 * Absolute paths are relativized against cwd; anything outside the workspace
 * (or any absolute path when cwd is unknown) is dropped because focus globs
 * are workspace-relative and could never match it. Returns undefined to drop.
 */
function normalizeHint(raw: string, cwd?: string): string | undefined {
	let p = raw.replace(/\/+$/, ""); // tolerate dir tokens like "src/"
	if (!p) return undefined;
	if (p.startsWith("/")) {
		if (!cwd) return undefined;
		const root = cwd.endsWith("/") ? cwd : `${cwd}/`;
		if (!p.startsWith(root)) return undefined; // outside workspace
		p = p.slice(root.length);
		return p || undefined;
	}
	return p;
}

/**
 * Extract path hints from raw entries: tool-call path args + path-shaped
 * text tokens. Absolute paths (the norm for real read/edit/bash calls) are
 * relativized against cwd so they can match workspace-relative focus globs.
 */
export function extractPathHints(entries: SessionEntryLike[], cwd?: string): string[] {
	const hints = new Set<string>();
	const addRaw = (raw: string | undefined) => {
		if (!raw) return;
		const normalized = normalizeHint(raw, cwd);
		if (normalized) hints.add(normalized);
	};
	const visitArg = (value: unknown) => {
		if (typeof value !== "string" || !value) return;
		addRaw(value);
	};
	const scanText = (text: string) => {
		PATH_TOKEN_RE.lastIndex = 0;
		let m: RegExpExecArray | null;
		while ((m = PATH_TOKEN_RE.exec(text)) !== null) addRaw(m[1]);
		ABS_PATH_RE.lastIndex = 0;
		while ((m = ABS_PATH_RE.exec(text)) !== null) addRaw(m[1]);
	};
	for (const entry of entries) {
		const content = entry.message?.content;
		if (!Array.isArray(content)) continue;
		for (const block of content) {
			if (!block || typeof block !== "object") continue;
			const b = block as { type?: string; text?: string; arguments?: Record<string, unknown> };
			if (b.type === "toolCall" && b.arguments) {
				for (const key of ["path", "file", "pattern"]) {
					visitArg(b.arguments[key]);
				}
				// Shell commands are compound strings, not single paths — scan them.
				const command = b.arguments["command"];
				if (typeof command === "string") scanText(command);
			}
			if (b.type === "text" && b.text) {
				scanText(b.text);
			}
		}
	}
	return [...hints];
}

export function matchesFocus(config: AdvisorConfig, entries: SessionEntryLike[], cwd?: string): boolean {
	if (!config.focus || config.focus.length === 0) return true;
	const hints = extractPathHints(entries, cwd);
	return hints.some(
		(h) =>
			(config.focus as string[]).some((g) => matchGlob(g, h)) &&
			!(config.ignore ?? []).some((g) => matchGlob(g, h)),
	);
}

// ─────────────────────────── runtime ───────────────────────────

export class AdvisorRuntime {
	#instances = new Map<string, AdvisorInstance>();
	#guard = new AdvisorEmissionGuard();
	#opts: AdvisorRuntimeOptions;
	#maxConsecutiveFailures: number;
	#sleep: (ms: number) => Promise<void>;
	#drainPromises = new Set<Promise<void>>();

	constructor(configs: AdvisorConfig[], opts: AdvisorRuntimeOptions) {
		this.#opts = opts;
		this.#maxConsecutiveFailures = opts.maxConsecutiveFailures ?? DEFAULT_MAX_CONSECUTIVE_FAILURES;
		this.#sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
		for (const config of configs) this.#instances.set(config.slug, newInstance(config));
	}

	/**
	 * turn_end entry point. Slices the branch per advisor, applies
	 * focus/frequency filters, enqueues, and kicks drains (priority-ordered).
	 * Fire-and-forget by design (ADR-003) — use settle() in tests.
	 */
	onTurnEnd(turnIndex: number): void {
		const instances = [...this.#instances.values()].sort(
			(a, b) =>
				(PRIORITY_RANK[a.config.trigger.priority ?? "normal"] ?? 1) -
				(PRIORITY_RANK[b.config.trigger.priority ?? "normal"] ?? 1),
		);
		for (const inst of instances) {
			if (!inst.config.enabled || inst.halted) {
				this.#emit(inst, `skipped: ${inst.halted ? "halted" : "disabled"}`);
				continue;
			}
			let slice;
			try {
				slice = this.#opts.source.slice(inst.cursor);
			} catch {
				continue; // a broken source must never reach the primary
			}
			inst.cursor = slice.next;
			if (slice.resetDetected) this.#resetInstanceContext(inst);
			if (slice.entries.length === 0) {
				this.#emit(inst, "skipped: no new entries");
				continue;
			}
			if (!matchesFocus(inst.config, slice.entries, this.#opts.cwd)) {
				this.#emit(inst, "skipped: focus miss");
				continue;
			}
			if (!this.#passesFrequency(inst)) {
				this.#emit(inst, `skipped: frequency ${inst.turnsSinceTrigger}/${inst.config.trigger.frequency}`);
				continue;
			}
			let text: string;
			try {
				text = renderDelta(slice.entries, inst.scrubber);
			} catch {
				continue;
			}
			if (!text.trim()) continue;
			if (slice.resetDetected) {
				text = `[advisor context was reset — full recent transcript follows]\n\n${text}`;
			}
			inst.queue.push({ text, turnIndex, revision: inst.revision, queuedAt: Date.now() });
			this.#emit(inst, `queued delta (turn ${turnIndex}, ${text.length} chars)`);
			this.#kickDrain(inst);
		}
	}

	/** Await all in-flight drains (tests, /advisor now). */
	async settle(): Promise<void> {
		for (;;) {
			const pending = [...this.#drainPromises];
			if (pending.length === 0) return;
			await Promise.allSettled(pending);
		}
	}

	status(): AdvisorStatus[] {
		return [...this.#instances.values()].map((inst) => ({
			slug: inst.config.slug,
			name: inst.config.name,
			enabled: inst.config.enabled,
			halted: inst.halted,
			queued: inst.queue.length,
			draining: inst.draining,
			consecutiveFailures: inst.consecutiveFailures,
			revision: inst.revision,
			historyChars: estimateChars(inst.history),
			charBudget: charBudgetOf(inst.config),
			usage: { ...inst.usage },
		}));
	}

	setEnabled(slug: string, enabled: boolean): boolean {
		const inst = this.#instances.get(slug);
		if (!inst) return false;
		inst.config.enabled = enabled;
		return true;
	}

	/** /advisor reset: clear halt latch + all per-advisor state; cursor jumps to branch end. */
	reset(slug?: string): void {
		for (const inst of this.#instances.values()) {
			if (slug && inst.config.slug !== slug) continue;
			inst.epoch++; // invalidate the old instance's in-flight drain/timers
			const fresh = newInstance(inst.config);
			// Jump the cursor to the branch end WITHOUT replaying history
			// (ADR-005): slice from empty and keep only the resulting cursor.
			fresh.cursor = this.#opts.source.slice(emptyCursor()).next;
			this.#instances.set(inst.config.slug, fresh);
		}
		if (!slug) this.#guard.reset();
	}

	/** session_shutdown / extension teardown: invalidate in-flight drains. */
	dispose(): void {
		for (const inst of this.#instances.values()) {
			inst.epoch++;
			inst.queue.length = 0;
		}
	}

	/**
	 * session_compact: drop advisor histories (their context is now stale)
	 * and invalidate in-flight drains, but KEEP cursors — the next slice
	 * detects the branch rewrite via fingerprints and re-renders the
	 * compacted branch in full.
	 */
	resetContexts(): void {
		for (const inst of this.#instances.values()) {
			inst.epoch++;
			inst.queue.length = 0;
			this.#resetInstanceContext(inst);
		}
	}

	/** /advisor now: bypass focus/frequency gates and drain immediately. */
	forceTrigger(slug: string): string {
		const inst = this.#instances.get(slug);
		if (!inst) return `unknown advisor: ${slug}`;
		if (inst.halted) return `${slug} is halted — /advisor reset ${slug} lifts the latch`;
		if (!inst.config.enabled) return `${slug} is disabled — /advisor on ${slug} first`;
		const slice = this.#opts.source.slice(inst.cursor);
		inst.cursor = slice.next;
		if (slice.resetDetected) this.#resetInstanceContext(inst);
		if (slice.entries.length > 0) {
			let text = renderDelta(slice.entries, inst.scrubber);
			if (slice.resetDetected && text.trim()) {
				text = `[advisor context was reset — full recent transcript follows]\n\n${text}`;
			}
			if (text.trim())
				inst.queue.push({ text, turnIndex: -1, revision: inst.revision, queuedAt: Date.now() });
		}
		if (inst.queue.length === 0) return "nothing new to review";
		this.#kickDrain(inst);
		return `triggered ${slug} (${inst.queue.length} delta(s) queued)`;
	}

	get(slug: string): AdvisorStatus | undefined {
		return this.status().find((s) => s.slug === slug);
	}

	/**
	 * /advisor next: which advisors would fire if a turn ended right now.
	 * Pure preview — cursors and counters are NOT advanced.
	 */
	previewNext(): { slug: string; name: string; wouldTrigger: boolean; reason: string }[] {
		return [...this.#instances.values()].map((inst) => {
			const base = { slug: inst.config.slug, name: inst.config.name };
			if (!inst.config.enabled) return { ...base, wouldTrigger: false, reason: "disabled" };
			if (inst.halted) return { ...base, wouldTrigger: false, reason: "halted" };
			const slice = this.#opts.source.slice(inst.cursor);
			if (slice.entries.length === 0) return { ...base, wouldTrigger: false, reason: "no new entries" };
			if (!matchesFocus(inst.config, slice.entries, this.#opts.cwd)) {
				return { ...base, wouldTrigger: false, reason: "focus miss" };
			}
			if (inst.config.trigger.frequency === "per-N-turns") {
				const every = inst.config.trigger.every ?? 1;
				if (inst.turnsSinceTrigger + 1 < every) {
					return {
						...base,
						wouldTrigger: false,
						reason: `frequency: ${inst.turnsSinceTrigger + 1}/${every}`,
					};
				}
			}
			return { ...base, wouldTrigger: true, reason: "would trigger" };
		});
	}

	#passesFrequency(inst: AdvisorInstance): boolean {
		const trigger = inst.config.trigger;
		if (trigger.frequency === "per-update") return true;
		inst.turnsSinceTrigger++;
		const every = trigger.every ?? 1;
		if (inst.turnsSinceTrigger >= every) {
			inst.turnsSinceTrigger = 0;
			return true;
		}
		return false;
	}

	#resetInstanceContext(inst: AdvisorInstance): void {
		inst.history = [];
		inst.revision++;
		inst.queue = inst.queue.filter((d) => d.revision >= inst.revision);
		inst.scrubber.reset();
		inst.contextEscalation = "none";
	}

	#emit(inst: AdvisorInstance, message: string): void {
		try {
			this.#opts.onEvent?.(inst.config.slug, message);
		} catch {
			// Observers must never affect the runtime.
		}
	}

	#kickDrain(inst: AdvisorInstance): void {
		if (inst.draining) {
			// A drain is in flight (possibly in its backoff re-kick window).
			// Flag it so the drain's finally re-kicks after releasing the lock.
			inst.pendingKick = true;
			return;
		}
		inst.draining = true;
		const p = this.#drain(inst)
			.catch(() => {
				// Containment: drain handles its own errors; this is the last resort.
			})
			.finally(() => {
				inst.draining = false;
				this.#drainPromises.delete(p);
				if (inst.pendingKick) {
					inst.pendingKick = false;
					this.#kickDrain(inst);
				}
			});
		this.#drainPromises.add(p);
	}

	async #drain(inst: AdvisorInstance): Promise<void> {
		for (;;) {
			const epoch = inst.epoch;
			inst.queue = inst.queue.filter((d) => d.revision >= inst.revision);
			if (inst.queue.length === 0 || inst.halted) return;

			// Coalesce contiguous same-revision deltas into one batch.
			const rev = inst.queue[0]!.revision;
			const batch: PendingDelta[] = [];
			while (inst.queue.length > 0 && inst.queue[0]!.revision === rev) {
				batch.push(inst.queue.shift()!);
			}
			const text = batch.map((d) => d.text).join("\n\n");

			try {
				await this.#maintainContext(inst, text.length);
			} catch {
				// A failed summarize must not kill the batch — proceed anyway.
			}
			if (epoch !== inst.epoch) continue; // reset during await — batch is stale

			this.#guard.beginUpdate();
			const req = this.#buildRequest(inst, text);
			const executor = createReadonlyToolExecutor({
				cwd: this.#opts.cwd,
				allowedTools: inst.config.tools,
			});
			// Latency instrumentation: queue wait = time the oldest delta in this
			// batch sat in the queue (single-flight backlog shows up here).
			const oldestQueuedAt = Math.min(...batch.map((d) => d.queuedAt));
			const queueWaitMs = Date.now() - oldestQueuedAt;
			this.#emit(
				inst,
				`reviewing with ${inst.config.model} (${text.length} chars, queue wait ${queueWaitMs}ms)`,
			);

			const reviewStart = Date.now();
			let result;
			try {
				result = await runWithTools(this.#opts.caller, req, executor);
			} catch (err) {
				if (epoch !== inst.epoch) continue;
				const action = this.#handleFailure(inst, err, batch);
				this.#emit(
					inst,
					`failed: ${err instanceof Error ? err.message : String(err)} → ${action}`,
				);
				if (action === "retry-now") continue;
				if (action === "retry-later") return; // backoff timer re-kicks drain
				return; // halted
			}
			if (epoch !== inst.epoch) continue;

			inst.history.push({ role: "user", content: text });
			inst.history.push(...result.newMessages);
			inst.usage.input += result.usage.input;
			inst.usage.output += result.usage.output;
			inst.usage.calls += result.usage.calls;
			inst.consecutiveFailures = 0;
			inst.classifierRetried = false;
			inst.contextEscalation = "none";

			const reviewMs = Date.now() - reviewStart;
			this.#emit(
				inst,
				`reviewed: ${result.notes.length} note(s), tokens ↑${result.usage.input} ↓${result.usage.output}, review ${reviewMs}ms`,
			);
			if (result.notes.length === 0) {
				this.#emit(inst, "silent: no advice this batch");
			}
			for (const note of result.notes) {
				if (this.#guard.acceptNote(inst.config.slug, note)) {
					try {
						routeNote(this.#opts.injector, inst.config.name, note);
						this.#emit(
							inst,
							`injected [${note.severity}] turn→inject ${Date.now() - oldestQueuedAt}ms: ${note.note.slice(0, 80)}`,
						);
					} catch {
						// Injection failure must not abort remaining notes or the loop.
					}
				} else {
					this.#emit(inst, `dropped by emission guard [${note.severity}] ${note.note.slice(0, 80)}`);
				}
			}
		}
	}

	#buildRequest(inst: AdvisorInstance, batchText: string): CompleteRequest {
		return {
			systemPrompt: inst.config.prompt,
			messages: [...inst.history, { role: "user", content: batchText }],
			tools: [ADVISE_TOOL_DEF, ...toolDefsFor(inst.config.tools)],
			modelSpec: inst.config.model,
		};
	}

	/**
	 * maintainContext (§4.4): before feeding a batch, if history + batch
	 * exceeds the char budget — tier 2: summarize history into ≤2000 chars
	 * via one complete() call; tier 3: if still over, wipe history and bump
	 * revision so the next batch carries the full-render prefix.
	 */
	async #maintainContext(inst: AdvisorInstance, incomingChars: number): Promise<void> {
		const budget = charBudgetOf(inst.config);
		if (estimateChars(inst.history) + incomingChars <= budget) return;

		if (inst.history.length > 0) {
			const summary = await this.#opts.caller.complete({
				systemPrompt:
					"Compress the following advisor review history into a state summary " +
					`of at most ${SUMMARY_TARGET_CHARS} characters. Keep: issues already raised, ` +
					"how the primary agent responded, current areas of concern.",
				messages: [
					...inst.history,
					{ role: "user", content: "Write the summary now, plain text." },
				],
				tools: [],
				modelSpec: inst.config.model,
			});
			const summaryText = summary.content
				.filter((b) => b.type === "text")
				.map((b) => (b as { text: string }).text)
				.join("\n")
				.slice(0, SUMMARY_TARGET_CHARS * 2);
			inst.usage.calls++;
			inst.usage.input += summary.usage?.input ?? 0;
			inst.usage.output += summary.usage?.output ?? 0;
			inst.history = [{ role: "user", content: `[summary of earlier review]\n${summaryText}` }];
		}

		if (estimateChars(inst.history) + incomingChars > budget) {
			inst.history = [];
			inst.revision++;
			inst.contextEscalation = "none";
		}
	}

	/** Returns how the drain loop should proceed. */
	#handleFailure(
		inst: AdvisorInstance,
		err: unknown,
		batch: PendingDelta[],
	): "retry-now" | "retry-later" | "halt" {
		const cls = classifyFailure(err);
		switch (cls) {
			case "provider_permanent":
				inst.halted = true;
				inst.queue.length = 0;
				return "halt";
			case "advisor_context": {
				// complete() overflowed. Summarizing via another complete() would
				// overflow the same way, so escalation DROPS history directly:
				// tier 1 clears history, tier 2 also clears and lets the batch
				// carry on without memory. No revision bump — the requeued batch
				// must stay deliverable.
				inst.queue.unshift(...batch);
				if (inst.contextEscalation === "none") {
					inst.contextEscalation = "summarized";
					inst.history = [];
					return "retry-now";
				}
				if (inst.contextEscalation === "summarized") {
					inst.contextEscalation = "reset";
					inst.history = [];
					return "retry-now";
				}
				return this.#transient(inst, batch); // already escalated — treat as transient
			}
			case "classifier_refusal": {
				if (!inst.classifierRetried) {
					inst.classifierRetried = true;
					inst.queue.unshift(...batch);
					return "retry-now";
				}
				inst.halted = true;
				inst.queue.length = 0;
				return "halt";
			}
			case "timeout":
			case "provider_transient":
				return this.#transient(inst, batch);
		}
	}

	#transient(inst: AdvisorInstance, batch: PendingDelta[]): "retry-later" | "halt" {
		inst.consecutiveFailures++;
		if (inst.consecutiveFailures >= this.#maxConsecutiveFailures) {
			inst.halted = true;
			inst.queue.length = 0;
			return "halt";
		}
		inst.queue.unshift(...batch);
		const backoff = Math.min(BACKOFF_BASE_MS * 2 ** (inst.consecutiveFailures - 1), BACKOFF_CAP_MS);
		const epoch = inst.epoch;
		// Track the retry timer in drainPromises so settle() waits out the
		// backoff before declaring the runtime idle.
		const retry: Promise<void> = this.#sleep(backoff).then(() => {
			if (inst.epoch === epoch && !inst.halted) this.#kickDrain(inst);
		});
		this.#drainPromises.add(retry);
		void retry.finally(() => this.#drainPromises.delete(retry));
		return "retry-later";
	}
}

function newInstance(config: AdvisorConfig): AdvisorInstance {
	return {
		config,
		cursor: emptyCursor(),
		queue: [],
		draining: false,
		revision: 0,
		epoch: 0,
		consecutiveFailures: 0,
		halted: false,
		history: [],
		usage: { input: 0, output: 0, calls: 0 },
		turnsSinceTrigger: 0,
		classifierRetried: false,
		contextEscalation: "none",
		pendingKick: false,
		scrubber: new SecretScrubber(),
	};
}

export function charBudgetOf(config: AdvisorConfig): number {
	return Math.floor(config.maxTokens * CHARS_PER_TOKEN);
}

export function estimateChars(history: Message[]): number {
	let total = 0;
	for (const m of history) {
		if (m.role === "toolResult") {
			total += m.content.length;
			continue;
		}
		const content = m.content;
		if (typeof content === "string") {
			total += content.length;
			continue;
		}
		for (const block of content) {
			if (block.type === "text") total += (block as { text: string }).text.length;
			else if (block.type === "toolCall") total += JSON.stringify(block.arguments).length;
		}
	}
	return total;
}
