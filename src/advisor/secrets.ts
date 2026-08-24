/**
 * Secret scrubbing for advisor-bound deltas (architecture §2.3).
 *
 * Ported in spirit from oh-my-pi (`src/secrets/obfuscator.ts` +
 * `#advisorRegexSecretValues` in runtime.ts), deliberately simplified:
 * oh-my-pi maintains a reversible `«api-key:HASH»` mapping because its
 * advisors can call services needing the real values. pi-advisor advisors
 * only ever READ the primary's work, so replacements are a fixed
 * 15-`x` string — irreversible by design.
 *
 * Two mechanisms, applied in order on every `scrub(text)`:
 * 1. Built-in regex set (API keys / JWT / PEM / AWS / GitHub tokens /
 *    generic `api_key = "..."` assignments). Matched values are replaced
 *    AND collected into `collected`.
 * 2. Literal replacement of every previously collected value. Regexes
 *    can miss a value in a new context; once collected, it stays covered.
 *
 * `collected` is FIFO-evicted at 1024 entries to bound memory.
 */

/** Fixed replacement — 15 x's, matching the oh-my-pi advisor convention. */
export const REDACTED = "xxxxxxxxxxxxxxx";

const MAX_COLLECTED = 1024;

/**
 * Built-in patterns. Each pattern's capture group 1 (or the full match when
 * there is no group) is treated as the secret VALUE and collected.
 */
const PATTERNS: RegExp[] = [
	// OpenAI / OpenAI-compatible project keys
	/\b(sk-(?:proj-)?[A-Za-z0-9_-]{20,})\b/g,
	// Anthropic
	/\b(sk-ant-[A-Za-z0-9_-]{20,})\b/g,
	// GitHub tokens (pat, oauth, app, fine-grained)
	/\b((?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,})\b/g,
	// AWS access key id
	/\b((?:AKIA|ASIA)[A-Z0-9]{16})\b/g,
	// JWT (three base64url segments)
	/\b(eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})\b/g,
	// PEM private key blocks
	/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
	// Generic assignments: api_key / apikey / api-key / secret / token / password
	// followed by : or = and a quoted or bare value of ≥ 8 non-space chars.
	/\b(?:api[-_]?key|secret|token|password|passwd|credential)s?["']?\s*[:=]\s*["']([^"'\s]{8,})["']/gi,
	/\b(?:api[-_]?key|secret|token|password|passwd|credential)s?["']?\s*[:=]\s*([^\s"']{16,})/gi,
];

export class SecretScrubber {
	#collected = new Set<string>();
	#order: string[] = [];

	/**
	 * Replace every recognizable (or previously seen) secret in `text`
	 * with REDACTED. Newly regex-matched values are collected for future
	 * rounds.
	 */
	scrub(text: string): string {
		let out = text;
		// 1. regex pass — replace and collect
		for (const pattern of PATTERNS) {
			pattern.lastIndex = 0;
			out = out.replace(pattern, (full, group1?: string) => {
				const value = typeof group1 === "string" && group1.length > 0 ? group1 : full;
				this.#collect(value);
				// Preserve any non-secret wrapper around the value (assignment form).
				return full.replace(value, REDACTED);
			});
		}
		// 2. literal pass over collected values (longest first to avoid
		//    partial-prefix replacement leaving a tail of the secret behind)
		const values = [...this.#collected].sort((a, b) => b.length - a.length);
		for (const value of values) {
			if (value.length < 8) continue; // too short to replace safely
			if (out.includes(value)) {
				out = out.split(value).join(REDACTED);
			}
		}
		return out;
	}

	/** Clear collected values. Called when the advisor context resets. */
	reset(): void {
		this.#collected.clear();
		this.#order.length = 0;
	}

	/** Test/inspection hook. */
	get collectedCount(): number {
		return this.#collected.size;
	}

	#collect(value: string): void {
		if (value.length < 8 || value === REDACTED) return;
		if (this.#collected.has(value)) return;
		this.#collected.add(value);
		this.#order.push(value);
		if (this.#order.length > MAX_COLLECTED) {
			const stale = this.#order.shift();
			if (stale !== undefined) this.#collected.delete(stale);
		}
	}
}
