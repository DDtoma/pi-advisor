/**
 * ReadonlySessionManager → DeltaSource adapter (architecture §2.2).
 *
 * Structural type instead of importing pi's ReadonlySessionManager:
 * the adapter only needs getBranch(), and a structural type keeps the
 * glue surface minimal and version-tolerant.
 */
import { sliceEntries } from "../advisor/cursor.ts";
import type { Cursor, DeltaSlice, DeltaSource, SessionEntryLike } from "../advisor/types.ts";

export interface BranchProvider {
	getBranch(): unknown[];
}

export function createSessionSource(session: BranchProvider): DeltaSource {
	const branch = () => session.getBranch() as SessionEntryLike[];
	return {
		slice(cursor: Cursor): DeltaSlice {
			return sliceEntries(branch(), cursor);
		},
		length(): number {
			return branch().length;
		},
	};
}
