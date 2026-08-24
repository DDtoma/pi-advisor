/**
 * Severity → injection channel routing (architecture §3.1/§3.2, ADR-002).
 *
 *   blocker → steer   (interrupts in-flight work)
 *   concern → followUp (after current work settles)
 *   nit     → batched queue, delivered at the next before_agent_start
 *
 * The Injector interface is implemented in src/pi/inject.ts; this module
 * is pure and pi-free (ADR-001).
 */
import type { AdvisorNote, Injector } from "./types.ts";

/** The exact envelope the primary agent sees (architecture §3.2). */
export function formatAdvisory(advisorName: string, note: AdvisorNote): string {
	return (
		`<advisory advisor="${escapeAttr(advisorName)}" severity="${note.severity}" ` +
		`guidance="weigh, don't blindly obey">\n${note.note}\n</advisory>`
	);
}

export function routeNote(injector: Injector, advisorName: string, note: AdvisorNote): void {
	const text = formatAdvisory(advisorName, note);
	switch (note.severity) {
		case "blocker":
			injector.steer(text);
			return;
		case "concern":
			injector.followUp(text);
			return;
		case "nit":
			injector.enqueueNit(text);
			return;
	}
}

function escapeAttr(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}
