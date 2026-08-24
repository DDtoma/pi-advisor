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

/** Entries our own injections produce — never delivered back to advisors. */
export function isAdvisoryEntry(entry: SessionEntryLike): boolean {
	return entry.type === "custom_message" && entry.customType === "advisory";
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
