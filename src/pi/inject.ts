/**
 * Injector implementation over pi's ExtensionAPI (architecture §3.2).
 *
 * Every severity → pi.sendMessage({customType:"advisory", ...},
 * {deliverAs:"steer", triggerTurn:true}): an advisory that arrives late is
 * useless or worse, so all notes interrupt at the next tool-call boundary
 * instead of waiting for idle. Loss on crash between generation and
 * delivery is acceptable — the advisor is advisory-only.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Injector } from "../advisor/types.ts";

/**
 * Deliver an advisory as a steering custom message.
 * triggerTurn:true ensures the message always wakes the agent.
 */
function sendAdvisory(pi: ExtensionAPI, text: string, details?: unknown): void {
	pi.sendMessage(
		{ customType: "advisory", content: text, display: true, ...(details === undefined ? {} : { details }) },
		{ deliverAs: "steer", triggerTurn: true },
	);
}

export function createInjector(pi: ExtensionAPI): Injector {
	return {
		steer: (text, details) => sendAdvisory(pi, text, details),
	};
}
