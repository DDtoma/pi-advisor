/**
 * Step 0 spike (see docs/implementation-plan.md §Step 0):
 * proves the two facts the whole architecture rests on:
 *  1. extensions/index.ts may import ../src (pure TS, no pi deps) directly.
 *  2. ctx.modelRegistry.complete(model, context) is callable from an
 *     extension handler without starting an AgentSession.
 *
 * This minimal handler is replaced by the full composition root in Step 8.
 * Runtime verification (loading this extension in pi and actually calling
 * complete()) is deferred to Step 8's e2e pass per plan decision.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { REDACTED } from "../src/advisor/secrets.ts";
import type { Severity } from "../src/advisor/types.ts";

export default function advisorSpike(pi: ExtensionAPI): void {
	// Fact 1 probe: src/ import resolved at extension load time.
	const probe: Severity = "nit";
	void probe;
	void REDACTED;

	// Fact 2 probe: modelRegistry.complete is reachable from a handler.
	// Real invocation happens in Step 8 smoke testing.
	pi.on("session_start", async (_event, ctx) => {
		void ctx.modelRegistry;
	});
}
