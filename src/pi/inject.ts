/**
 * Injector implementation over pi's ExtensionAPI (architecture §3.2).
 *
 * blocker → pi.sendUserMessage(text, {deliverAs:"steer"})
 * concern → pi.sendUserMessage(text, {deliverAs:"followUp"})
 * nit     → nitQueue; drained by the extension's before_agent_start
 *           handler into one batched custom_message.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Injector } from "../advisor/types.ts";

export interface PiInjector extends Injector {
	/** Drain the nit queue; undefined when empty. O(n) once per agent start. */
	drainNits(): string | undefined;
	/** Inspection for /advisor status. */
	readonly nitDepth: number;
}

export function createInjector(pi: ExtensionAPI): PiInjector {
	const nitQueue: string[] = [];
	return {
		steer: (text) => pi.sendUserMessage(text, { deliverAs: "steer" }),
		followUp: (text) => pi.sendUserMessage(text, { deliverAs: "followUp" }),
		enqueueNit(text: string) {
			nitQueue.push(text);
		},
		drainNits(): string | undefined {
			if (nitQueue.length === 0) return undefined;
			return nitQueue.splice(0, nitQueue.length).join("\n\n");
		},
		get nitDepth() {
			return nitQueue.length;
		},
	};
}
