/**
 * Incremental cursor over the primary session branch (architecture §4.1).
 *
 * A cursor is {count, fingerprints[]} where fingerprints[i] is
 * sha1(JSON.stringify(branch[i])) for every entry already delivered.
 * Slicing detects two kinds of history rewrite:
 *  - compaction:   branch.length < cursor.count
 *  - in-place edit: fingerprint mismatch at any delivered index
 * Both force a full reset: the whole branch is re-rendered and the cursor
 * is rebuilt from scratch.
 *
 * Anti-recursion: entries injected BY advisors (`custom_message` with
 * customType "advisory") are skipped from delivery but STILL counted and
 * fingerprinted — otherwise the cursor would drift every time our own
 * injection lands in the branch.
 */
import { createHash } from "node:crypto";
import type { Cursor, DeltaSlice, SessionEntryLike } from "./types.ts";

export function emptyCursor(): Cursor {
	return { count: 0, fingerprints: [] };
}

export function fingerprintEntry(entry: SessionEntryLike): string {
	return createHash("sha1").update(JSON.stringify(entry)).digest("hex");
}

const ADVISORY_ENVELOPE_RE = /^<advisory[\s>]/;

/** Entries our own injections produce — never delivered back to advisors. */
export function isAdvisoryEntry(entry: SessionEntryLike): boolean {
	// Nit batches arrive as custom_message entries.
	if (entry.type === "custom_message" && entry.customType === "advisory") return true;
	// Tolerance fallback: hand-inserted user-role `<advisory>` text (sessions are
	// open files) is identified by envelope prefix so genuine user messages stay
	// deliverable. New injections never take this path (all channels are custom_message).
	if (entry.type !== "message") return false;
	const message = entry.message as { role?: string; content?: unknown } | undefined;
	if (!message || message.role !== "user") return false;
	const content = message.content;
	if (typeof content === "string") return ADVISORY_ENVELOPE_RE.test(content.trimStart());
	if (!Array.isArray(content)) return false;
	return content.some((block) => {
		const b = block as { type?: string; text?: unknown } | null;
		return b?.type === "text" && typeof b.text === "string" && ADVISORY_ENVELOPE_RE.test(b.text.trimStart());
	});
}

/**
 * Pure slicing logic, independent of pi's SessionManager so it can be
 * unit-tested with plain entry fixtures. `session-source.ts` adapts
 * ReadonlySessionManager.getBranch() to this function.
 */
export function sliceEntries(entries: SessionEntryLike[], cursor: Cursor): DeltaSlice {
	const resetDetected =
		entries.length < cursor.count || hasInPlaceMutation(entries, cursor);

	const effectiveCount = resetDetected ? 0 : cursor.count;

	const freshFingerprints: string[] = new Array(entries.length);
	for (let i = 0; i < entries.length; i++) {
		// Reuse already-computed fingerprints for unchanged delivered entries.
		if (!resetDetected && i < cursor.count && cursor.fingerprints[i] !== undefined) {
			freshFingerprints[i] = cursor.fingerprints[i] as string;
		} else {
			freshFingerprints[i] = fingerprintEntry(entries[i] as SessionEntryLike);
		}
	}

	const delivered: SessionEntryLike[] = [];
	for (let i = effectiveCount; i < entries.length; i++) {
		const entry = entries[i] as SessionEntryLike;
		if (isAdvisoryEntry(entry)) continue; // counted, but not delivered
		delivered.push(entry);
	}

	return {
		entries: delivered,
		next: { count: entries.length, fingerprints: freshFingerprints },
		resetDetected,
	};
}

function hasInPlaceMutation(entries: SessionEntryLike[], cursor: Cursor): boolean {
	const checkUpTo = Math.min(cursor.count, entries.length, cursor.fingerprints.length);
	for (let i = 0; i < checkUpTo; i++) {
		if (fingerprintEntry(entries[i] as SessionEntryLike) !== cursor.fingerprints[i]) {
			return true;
		}
	}
	// If we delivered MORE than we have fingerprints for, something is
	// inconsistent — treat as mutation.
	return cursor.fingerprints.length < cursor.count;
}
