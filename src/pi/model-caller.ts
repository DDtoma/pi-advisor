/**
 * ModelCaller implementation over ctx.modelRegistry.complete
 * (architecture §3.1, ADR-004).
 *
 * - modelSpec "provider/model-id[:thinking]" resolved via registry.find;
 *   the thinking suffix maps to the request's reasoning level.
 * - 120s AbortSignal timeout per complete() (architecture §9).
 * - pi AssistantMessage → CompleteResult normalization; thinking blocks
 *   dropped (ADR-008), tool calls preserved for the engine loop.
 *
 * Only this file and inject.ts may import pi packages (ADR-001).
 */
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import type {
	Api,
	AssistantMessage,
	Context,
	Message as PiMessage,
	Model,
	ThinkingLevel,
	Tool,
	ToolCall,
	Usage,
} from "@earendil-works/pi-ai";
import type {
	CompleteRequest,
	CompleteResult,
	ContentBlock,
	Message,
	ModelCaller,
} from "../advisor/types.ts";

const COMPLETE_TIMEOUT_MS = 120_000;
const THINKING_LEVELS = new Set([
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
]);

export function parseModelSpec(spec: string): {
	provider: string;
	modelId: string;
	thinking?: ThinkingLevel;
} {
	const slash = spec.indexOf("/");
	if (slash <= 0)
		throw permanentError(
			`model not found: "${spec}" (expected provider/model-id)`,
		);
	const rest = spec.slice(slash + 1);
	const colon = rest.lastIndexOf(":");
	let modelId = rest;
	let thinking: ThinkingLevel | undefined;
	if (colon > 0) {
		const suffix = rest.slice(colon + 1);
		if (THINKING_LEVELS.has(suffix)) {
			modelId = rest.slice(0, colon);
			thinking = suffix as ThinkingLevel;
		}
	}
	const out: { provider: string; modelId: string; thinking?: ThinkingLevel } = {
		provider: spec.slice(0, slash),
		modelId,
	};
	if (thinking) out.thinking = thinking;
	return out;
}

function permanentError(message: string): Error {
	return Object.assign(new Error(message), { status: 401 });
}

export function createModelCaller(registry: ModelRegistry): ModelCaller {
	return {
		async complete(req: CompleteRequest): Promise<CompleteResult> {
			const spec = parseModelSpec(req.modelSpec ?? "");
			const model: Model<Api> | undefined = registry.find(
				spec.provider,
				spec.modelId,
			);
			if (!model) {
				throw permanentError(`model not found: ${spec.provider}/${spec.modelId}`);
			}
			if (!registry.hasConfiguredAuth(model)) {
				throw permanentError(
					`permission: no credentials configured for ${spec.provider}/${spec.modelId}`,
				);
			}
			const context: Context = {
				systemPrompt: req.systemPrompt,
				messages: req.messages.map((m) => toPiMessage(m, model)),
				// SAFETY: CompleteRequest.tools is the pi-free mirror of pi-ai's
				// Tool (same {name, description, parameters: Type.Object(...)} shape,
				// api-verification §5.4); src/advisor cannot import pi-ai (ADR-001),
				// so the structural identity is asserted here instead of by types.
				tools: req.tools as unknown as Tool[],
			};
			const options: { signal: AbortSignal; reasoning?: ThinkingLevel } = {
				signal: req.signal ?? AbortSignal.timeout(COMPLETE_TIMEOUT_MS),
			};
			if (spec.thinking) options.reasoning = spec.thinking;
			const res: AssistantMessage = await registry.complete(
				model,
				context,
				options,
			);
			return {
				stopReason: res.stopReason,
				content: fromPiContent(res),
				usage: { input: res.usage?.input ?? 0, output: res.usage?.output ?? 0 },
			};
		},
	};
}

function toPiMessage(m: Message, model: Model<Api>): PiMessage {
	const timestamp = m.timestamp ?? Date.now();
	if (m.role === "user") {
		return { role: "user", content: m.content, timestamp };
	}
	if (m.role === "toolResult") {
		return {
			role: "toolResult",
			toolCallId: m.toolCallId,
			toolName: m.toolName,
			content: [{ type: "text", text: m.content }],
			isError: m.isError ?? false,
			timestamp,
		};
	}
	// assistant — reconstruct the fields pi requires on replay.
	const content = m.content
		.filter(
			(b): b is ContentBlock & { type: "text" | "toolCall" } =>
				b.type === "text" || b.type === "toolCall",
		)
		.map((b) =>
			b.type === "text"
				? { type: "text" as const, text: b.text }
				: {
						type: "toolCall" as const,
						id: b.id,
						name: b.name,
						// SAFETY: the pi-free mirror widens ToolCall["arguments"]
						// (JsonObject) to Record<string, unknown>; values originate
						// from pi tool calls, so they stay JSON. Indexed access keeps
						// this compiling against pi-ai versions that type arguments
						// more loosely.
						arguments: b.arguments as ToolCall["arguments"],
					},
		);
	return {
		role: "assistant",
		content,
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: ZERO_USAGE,
		stopReason: (m.stopReason ?? "stop") as AssistantMessage["stopReason"],
		timestamp,
	};
}

const ZERO_USAGE: Usage = {
	input: 0,
	output: 0,
	cost: { input: 0, output: 0, total: 0 },
	totalTokens: 0,
} as Usage;

function fromPiContent(res: AssistantMessage): ContentBlock[] {
	const out: ContentBlock[] = [];
	for (const block of res.content) {
		if (block.type === "text") out.push({ type: "text", text: block.text });
		else if (block.type === "toolCall") {
			out.push({
				type: "toolCall",
				id: block.id,
				name: block.name,
				arguments: (block.arguments ?? {}) as Record<string, unknown>,
			});
		}
		// thinking blocks intentionally dropped (ADR-008)
	}
	return out;
}
