/**
 * Renders primary-session entries to the flat markdown advisors consume
 * (architecture §2.1 layer 3, §9 budgets).
 *
 * Shape:
 *   ### User
 *   <text>
 *
 *   ### Assistant
 *   <text>
 *   **Tool call:** `read({"path":"..."})`
 *
 *   ### Tool(read)
 *   <result text>
 *
 * Rules (implementation-plan Step 2):
 *  - assistant thinking blocks are DROPPED (ADR-008: our delta source is
 *    SessionEntry-based and never contains reasoning content anyway).
 *  - each entry renders to at most MAX_ENTRY_CHARS, truncated with a tail
 *    marker stating the original length.
 *  - toolCall args JSON truncated to MAX_ARGS_CHARS.
 *  - toolResult prefixed with `[error] ` when isError.
 *  - ALL text passes through scrubber.scrub() before it leaves this module.
 */
import type { SecretScrubber } from "./secrets.ts";
import type { SessionEntryLike } from "./types.ts";

export const MAX_ENTRY_CHARS = 6000;
export const MAX_ARGS_CHARS = 500;

export interface RenderOptions {
	maxEntryChars?: number;
	maxArgsChars?: number;
}

interface TextBlock {
	type: "text";
	text: string;
}
interface ToolCallBlock {
	type: "toolCall";
	name?: string;
	arguments?: Record<string, unknown>;
}
interface ToolResultBlock {
	type: "toolResult";
	content?: unknown;
	isError?: boolean;
}
type Block = TextBlock | ToolCallBlock | ToolResultBlock | { type: string };

export function renderDelta(
	entries: SessionEntryLike[],
	scrubber: SecretScrubber,
	opts: RenderOptions = {},
): string {
	const maxEntry = opts.maxEntryChars ?? MAX_ENTRY_CHARS;
	const maxArgs = opts.maxArgsChars ?? MAX_ARGS_CHARS;
	const parts: string[] = [];
	for (const entry of entries) {
		const rendered = renderEntry(entry, scrubber, maxEntry, maxArgs);
		if (rendered) parts.push(rendered);
	}
	return parts.join("\n\n");
}

function renderEntry(
	entry: SessionEntryLike,
	scrubber: SecretScrubber,
	maxEntry: number,
	maxArgs: number,
): string | undefined {
	if (entry.type === "message" && entry.message) {
		const role = entry.message.role;
		const content = Array.isArray(entry.message.content) ? entry.message.content : [];
		let body: string;
		let header: string;
		if (role === "user") {
			header = "### User";
			body = renderBlocks(content as Block[], scrubber, maxArgs);
		} else if (role === "assistant") {
			header = "### Assistant";
			body = renderBlocks(content as Block[], scrubber, maxArgs);
		} else if (role === "toolResult") {
			// Tool result message: header carries the tool name when known.
			const first = content[0] as ToolResultBlock | undefined;
			const name = toolNameOf(entry) ?? "tool";
			header = `### Tool(${name})`;
			body = renderBlocks(content as Block[], scrubber, maxArgs);
			void first;
		} else {
			return undefined;
		}
		if (!body.trim()) return undefined;
		return truncateEntry(`${header}\n${body}`, maxEntry);
	}
	if (entry.type === "compaction") {
		const summary = (entry as { summary?: string }).summary;
		if (!summary) return undefined;
		return truncateEntry(`### System\n[context compacted]\n${scrubber.scrub(summary)}`, maxEntry);
	}
	// branch_summary, label, model/thinking changes, custom entries: not
	// part of the advisor's view of the work.
	return undefined;
}

function renderBlocks(blocks: Block[], scrubber: SecretScrubber, maxArgs: number): string {
	const out: string[] = [];
	for (const block of blocks) {
		if (block.type === "thinking" || block.type === "redacted_thinking") {
			continue; // ADR-008
		}
		if (block.type === "text") {
			const text = (block as TextBlock).text;
			if (text?.trim()) out.push(scrubber.scrub(text));
			continue;
		}
		if (block.type === "toolCall") {
			const call = block as ToolCallBlock;
			const argsJson = safeJson(call.arguments ?? {});
			const truncatedArgs =
				argsJson.length > maxArgs
					? `${argsJson.slice(0, maxArgs)}…`
					: argsJson;
			out.push(`**Tool call:** \`${call.name ?? "unknown"}(${scrubber.scrub(truncatedArgs)})\``);
			continue;
		}
		if (block.type === "toolResult") {
			const result = block as ToolResultBlock;
			const text = scrubber.scrub(resultContentToText(result.content));
			out.push(`${result.isError ? "[error] " : ""}${text}`);
			continue;
		}
		// Unknown block types are ignored — advisors only see the work record.
	}
	return out.join("\n");
}

function toolNameOf(entry: SessionEntryLike): string | undefined {
	const name = (entry.message as { toolName?: string } | undefined)?.toolName;
	return typeof name === "string" && name ? name : undefined;
}

function resultContentToText(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.map((c) => {
				if (typeof c === "string") return c;
				if (c && typeof c === "object" && (c as { type?: string }).type === "text") {
					return (c as { text?: string }).text ?? "";
				}
				return "";
			})
			.filter(Boolean)
			.join("\n");
	}
	return safeJson(content ?? "");
}

function safeJson(value: unknown): string {
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}

function truncateEntry(text: string, maxEntry: number): string {
	if (text.length <= maxEntry) return text;
	return `${text.slice(0, maxEntry)}\n\n[… truncated — full entry ${text.length} chars]`;
}
