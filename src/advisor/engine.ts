/**
 * The advisor tool loop (architecture §3.1, ADR-004).
 *
 * engine.ts owns ONLY the loop around the ModelCaller interface — the pi
 * implementation of ModelCaller lives in src/pi/model-caller.ts (ADR-001).
 *
 * Protocol: complete() → stopReason "toolUse" → execute each non-`advise`
 * call via the ToolExecutor (result truncated to TOOL_RESULT_CAP chars) →
 * append toolResult messages → complete() again. An `advise` call is NOT
 * executed; its arguments are collected as an AdvisorNote and the loop
 * ends — the advisor has said what it wanted to say. Any other stopReason
 * ends the loop. Hard cap of MAX_TOOL_ROUNDS complete() calls per batch.
 */
import type {
	AdvisorAssistantMessage,
	AdvisorNote,
	CompleteRequest,
	Message,
	ModelCaller,
	Severity,
	ToolCallBlock,
	ToolExecutor,
	ToolResultMessage,
	UsageTotals,
} from "./types.ts";

export const MAX_TOOL_ROUNDS = 8;
export const TOOL_RESULT_CAP = 2000;

export interface RunResult {
	notes: AdvisorNote[];
	/** Messages generated during the loop (assistant + toolResult), in order. */
	newMessages: Message[];
	usage: UsageTotals;
	/** How the loop ended: advise collected, final text, or round cap hit. */
	endedBy: "advise" | "stop" | "roundCap";
	/** stopReason of the final complete() call. */
	lastStopReason: string;
}

const VALID_SEVERITIES = new Set<Severity>(["nit", "concern", "blocker"]);

export async function runWithTools(
	caller: ModelCaller,
	req: CompleteRequest,
	executor: ToolExecutor,
	opts: { maxRounds?: number; toolResultCap?: number } = {},
): Promise<RunResult> {
	const maxRounds = opts.maxRounds ?? MAX_TOOL_ROUNDS;
	const cap = opts.toolResultCap ?? TOOL_RESULT_CAP;

	const messages: Message[] = [...req.messages];
	const newMessages: Message[] = [];
	const notes: AdvisorNote[] = [];
	const usage: UsageTotals = { input: 0, output: 0, calls: 0 };
	let lastStopReason = "unknown";
	let endedBy: RunResult["endedBy"] = "stop";

	for (let round = 0; round < maxRounds; round++) {
		const res = await caller.complete({ ...req, messages });
		lastStopReason = res.stopReason;
		usage.calls++;
		usage.input += res.usage?.input ?? 0;
		usage.output += res.usage?.output ?? 0;

		const assistantMsg: AdvisorAssistantMessage = {
			role: "assistant",
			content: res.content,
			stopReason: res.stopReason,
		};
		messages.push(assistantMsg);
		newMessages.push(assistantMsg);

		if (res.stopReason !== "toolUse") break;

		const calls = res.content.filter(
			(b): b is ToolCallBlock => b.type === "toolCall",
		);
		if (calls.length === 0) break; // claimed toolUse but no calls — stop defensively

		const results: ToolResultMessage[] = [];
		for (const call of calls) {
			if (call.name === "advise") {
				const parsed = parseAdviseArgs(call.arguments);
				if (parsed) notes.push(parsed);
				continue; // advise calls are never executed
			}
			const out = await executor.execute(call.name, call.arguments);
			results.push({
				role: "toolResult",
				toolCallId: call.id,
				toolName: call.name,
				content:
					out.content.length > cap ? `${out.content.slice(0, cap)}…` : out.content,
				isError: out.isError ?? false,
			});
		}
		for (const r of results) {
			messages.push(r);
			newMessages.push(r);
		}
		if (notes.length > 0) {
			endedBy = "advise";
			return { notes, newMessages, usage, endedBy, lastStopReason };
		}
		if (round === maxRounds - 1) endedBy = "roundCap";
	}

	if (notes.length === 0 && lastStopReason === "toolUse") endedBy = "roundCap";
	return { notes, newMessages, usage, endedBy, lastStopReason };
}

/**
 * Validate + coerce advise tool arguments into an AdvisorNote.
 * Missing/empty note → undefined (call ignored). Unknown severity coerces
 * to "concern" — a real note with a typo'd severity is still worth hearing.
 */
function parseAdviseArgs(
	args: Record<string, unknown>,
): AdvisorNote | undefined {
	const text = args["note"];
	if (typeof text !== "string" || !text.trim()) return undefined;
	const sevRaw = args["severity"];
	const severity: Severity = VALID_SEVERITIES.has(sevRaw as Severity)
		? (sevRaw as Severity)
		: "concern";
	const note: AdvisorNote = { note: text.trim(), severity };
	if (typeof args["skipIf"] === "string" && args["skipIf"].trim()) {
		note.skipIf = args["skipIf"].trim();
	}
	return note;
}

/** The advise tool definition every advisor gets, in addition to its whitelist. */
export const ADVISE_TOOL_DEF = {
	name: "advise",
	description:
		"Deliver one terse note to the primary agent. At most one per update. NEVER repeat a note you already gave. Silence is correct when there is nothing material.",
	parameters: {
		type: "object",
		properties: {
			note: {
				type: "string",
				description: "Terse, specific, actionable — 1–2 sentences. Cite file:line.",
			},
			severity: { type: "string", enum: ["nit", "concern", "blocker"] },
			skipIf: {
				type: "string",
				description:
					"Short marker; if a future note still matches this, it is dropped.",
			},
		},
		required: ["note", "severity"],
	},
} as const;
