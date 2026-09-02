/**
 * Note → injection routing (architecture §3.1/§3.2, ADR-002).
 *
 * Every severity goes through steer: an advisory that arrives late is
 * useless or worse, so delivery latency beats non-intrusiveness. Loss is
 * acceptable (the advisor is advisory-only; a dropped note never blocks
 * the primary agent's work).
 *
 * The Injector interface is implemented in src/pi/inject.ts; this module
 * is pure and pi-free (ADR-001).
 */
import type { AdvisorNote, Injector, Severity } from "./types.ts";

/** The exact envelope the primary agent sees (architecture §3.2). */
export function formatAdvisory(advisorName: string, note: AdvisorNote): string {
	return (
		`<advisory advisor="${escapeAttr(advisorName)}" severity="${note.severity}" ` +
		`guidance="weigh, don't blindly obey">\n${note.note}\n</advisory>`
	);
}

/** One parsed `<advisory>` envelope, as produced by formatAdvisory. */
export interface AdvisoryEnvelope {
	advisor: string;
	severity: Severity;
	text: string;
}

/**
 * Parse every advisory envelope out of a message body. Legacy nit batches
 * joined several envelopes with "\n\n", so there may be more than one.
 * Unknown severities coerce to "concern" (mirrors parseAdviseArgs).
 */
export function parseAdvisories(content: string): AdvisoryEnvelope[] {
	const out: AdvisoryEnvelope[] = [];
	for (const m of content.matchAll(/<advisory\s+((?:"[^"]*"|[^>])*)>([\s\S]*?)<\/advisory>/g)) {
		const attrs = m[1] ?? "";
		const advisor = unescapeAttr(/advisor="([^"]*)"/.exec(attrs)?.[1] ?? "advisor");
		const sevRaw = /severity="([^"]*)"/.exec(attrs)?.[1];
		const severity: Severity = sevRaw === "nit" || sevRaw === "blocker" ? sevRaw : "concern";
		const text = (m[2] ?? "").trim();
		if (text) out.push({ advisor, severity, text });
	}
	return out;
}

export function routeNote(injector: Injector, advisorName: string, note: AdvisorNote): void {
	const text = formatAdvisory(advisorName, note);
	injector.steer(text, note.fullNote ? { fullNote: note.fullNote } : undefined);
}

function escapeAttr(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

function unescapeAttr(value: string): string {
	return value.replace(/&lt;/g, "<").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
}
