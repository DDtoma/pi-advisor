/**
 * pi-advisor core types.
 *
 * This module is the contract surface of the whole subsystem (ADR-001).
 * Everything in `src/advisor/` depends only on these types; pi-specific
 * implementations of DeltaSource / ModelCaller / Injector live in `src/pi/`.
 *
 * No imports from pi / pi-ai / node — pure type definitions plus the
 * Severity union. Unit tests feed structural literals.
 */

/** Severity of an advisor note, from least to most intrusive. */
export type Severity = "nit" | "concern" | "blocker";

/** Max length of a note's review text. Enforced by the advise tool schema (maxLength) with a runtime clamp in engine.ts as belt-and-suspenders. */
export const MAX_NOTE_CHARS = 500;

/** A single review note emitted by an advisor via the `advise` tool. */
export interface AdvisorNote {
	/** The review text, ≤ 500 chars (enforced by the advise tool schema). */
	note: string;
	/** Untruncated text, present only when `note` was clamped at MAX_NOTE_CHARS. Never routed into LLM context — carried as message details for the renderer. */
	fullNote?: string;
	severity: Severity;
	/** If present, declares this batch not worth surfacing — note dropped. */
	skipIf?: string;
}

/** Frequency at which an advisor is triggered. */
export type TriggerFrequency = "per-update" | "per-N-turns";

export interface TriggerConfig {
	frequency: TriggerFrequency;
	/** Required when frequency === "per-N-turns". */
	every?: number;
	/** Queue-congestion priority; high drains first. Default "normal". */
	priority?: "low" | "normal" | "high";
}

/** How an advisor reacts to repeated failures. */
export type FailurePolicy = "halt" | "backoff";

/** One advisor declaration from WATCHDOG.yml (post-validation). */
export interface AdvisorConfig {
	/** Display name (not an identity; may repeat across global/project). */
	name: string;
	/** Unique identity, [a-z0-9-]+. Immutable at runtime. */
	slug: string;
	/** "provider/model-id[:thinking]" */
	model: string;
	/** Review instructions, ≤ 5000 chars. */
	prompt: string;
	/** Glob list; a delta mentioning no matching path skips this advisor. */
	focus?: string[];
	/** Globs excluded from focus matches. */
	ignore?: string[];
	/** Read-only tools granted to this advisor. Default []. */
	tools: ReadonlyToolName[];
	trigger: TriggerConfig;
	/** Advisor-context character budget = maxTokens * 3.5. Default 80000. */
	maxTokens: number;
	failurePolicy: FailurePolicy;
	enabled: boolean;
}

export type ReadonlyToolName = "read" | "grep" | "find" | "ls" | "bash";

/** Failure taxonomy (architecture §3.3). */
export type FailureClass =
	/** 401/403/model-missing → halt this advisor. */
	| "provider_permanent"
	/** 429/5xx/network → exponential backoff; N consecutive → halt. */
	| "provider_transient"
	/** complete() reported context overflow → escalate maintainContext. */
	| "advisor_context"
	/** Content classifier refusal → retry once, then halt. */
	| "classifier_refusal"
	/** Single complete() exceeded timeout → counts as transient. */
	| "timeout";

/**
 * Incremental cursor over the primary transcript branch (architecture §4.1).
 */
export interface Cursor {
	/** Number of branch entries already delivered (oh-my-pi #lastCount). */
	count: number;
	/** sha1 of JSON.stringify(entry) for each delivered entry. */
	fingerprints: string[];
}

/** Result of slicing a branch at a cursor. */
export interface DeltaSlice {
	entries: SessionEntryLike[];
	next: Cursor;
	/** True when the branch shrank or a delivered prefix entry mutated. */
	resetDetected: boolean;
}

/**
 * Structural subset of pi's SessionEntry the core needs (ADR-001).
 * Tests feed literals; `src/pi/session-source.ts` adapts real entries.
 */
export interface SessionEntryLike {
	type: string;
	customType?: string;
	message?: {
		role?: string;
		content?: unknown;
		stopReason?: string;
		/** pi toolResult messages carry the tool name here. */
		toolName?: string;
	};
	/** Free-form extras are fingerprinted but not interpreted by the core. */
	[key: string]: unknown;
}

/** A rendered, queued unit of work for one advisor. */
export interface PendingDelta {
	/** Rendered markdown of the new entries (already secret-scrubbed). */
	text: string;
	/** Turn index from the turn_end event (for tracing/rate limits). */
	turnIndex: number;
	/** Advisor context generation; deltas from older revisions are dropped. */
	revision: number;
}

// ---------------------------------------------------------------------------
// pi-ai structural subsets (messages exchanged with the advisor model)
// ---------------------------------------------------------------------------

export interface TextContent {
	type: "text";
	text: string;
}

export interface ToolCallBlock {
	type: "toolCall";
	id: string;
	name: string;
	arguments: Record<string, unknown>;
}

export type ContentBlock = TextContent | ToolCallBlock;

export interface UserMessage {
	role: "user";
	content: string | TextContent[];
	timestamp?: number; // optional inside advisor history; model-caller stamps it at the pi boundary
}

export interface AdvisorAssistantMessage {
	role: "assistant";
	content: ContentBlock[];
	stopReason?: string;
	usage?: { input?: number; output?: number };
	timestamp?: number; // optional inside advisor history; model-caller stamps it at the pi boundary
}

export interface ToolResultMessage {
	role: "toolResult";
	toolCallId: string;
	toolName: string;
	content: string;
	isError?: boolean;
	timestamp?: number; // optional inside advisor history; model-caller stamps it at the pi boundary
}

export type Message = UserMessage | AdvisorAssistantMessage | ToolResultMessage;

/** Tool definition passed to the advisor model (typebox-compatible JSON schema). */
export interface ToolDef {
	name: string;
	description: string;
	parameters: unknown;
}

// ---------------------------------------------------------------------------
// Injected interfaces — the core's only view of the outside world (ADR-001)
// ---------------------------------------------------------------------------

/** Source of primary-transcript deltas. Implemented by src/pi/session-source.ts. */
export interface DeltaSource {
	slice(cursor: Cursor): DeltaSlice;
	/** Current branch length — used to park the cursor at the tail on session start. */
	length(): number;
}

/** LLM call abstraction. Implemented by src/pi/model-caller.ts. */
export interface ModelCaller {
	complete(req: CompleteRequest): Promise<CompleteResult>;
}

export interface CompleteRequest {
	systemPrompt: string;
	messages: Message[];
	tools: ToolDef[];
	/**
		"provider/model-id[:thinking]" from the advisor config. The pi-side
		ModelCaller resolves it through the model registry; test fakes ignore it.
	*/
	modelSpec?: string;
	signal?: AbortSignal;
}

export interface CompleteResult {
	stopReason: string;
	content: ContentBlock[];
	usage?: { input?: number; output?: number };
}

/** Advice injection channel back into the primary session. */
export interface Injector {
	/** Interrupt channel for every severity. `details` is opaque message metadata (never in LLM context) — carries the untruncated note when clamped. */
	steer(text: string, details?: unknown): void;
}

/** Read-only tool execution for the advisor tool loop. */
export interface ToolExecutor {
	execute(
		name: string,
		args: Record<string, unknown>,
	): Promise<{ content: string; isError?: boolean }>;
}

/** Token accounting for /advisor status. */
export interface UsageTotals {
	input: number;
	output: number;
	calls: number;
}
