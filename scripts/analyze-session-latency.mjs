#!/usr/bin/env node
/**
 * Estimate advisory lateness from pi session JSONL files (no debug log
 * needed). For every advisory custom message, find the work it talks
 * about — via file names cited in the note — and measure how long ago
 * (wall clock + assistant turns) the session last touched those files
 * before the advisory landed.
 *
 * Usage: node scripts/analyze-session-latency.mjs [sessionsDir]
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { homedir } from "node:os";

const sessionsDir =
	process.argv[2] ?? join(homedir(), ".pi", "agent", "sessions");

const FILE_TOKEN_RE =
	/[\w@.+-]+\.(?:ts|tsx|js|mjs|cjs|jsx|py|el|elc|md|json|ya?ml|toml|rs|go|java|rb|sh|bash|sql|css|scss|html|vue|svelte|c|cc|cpp|h|hpp|lua|vim|org|nix)(?::\d+(?:,\d+)?)?/g;

function* walk(dir) {
	for (const name of readdirSync(dir)) {
		const p = join(dir, name);
		const st = statSync(p);
		if (st.isDirectory()) yield* walk(p);
		else if (name.endsWith(".jsonl")) yield p;
	}
}

function pathsOfMessage(message) {
	const out = new Set();
	const addToken = (tok) => out.add(basename(tok.replace(/:\d+(?:,\d+)?$/, "")));
	const scanText = (text) => {
		FILE_TOKEN_RE.lastIndex = 0;
		let m;
		while ((m = FILE_TOKEN_RE.exec(text)) !== null) addToken(m[0]);
	};
	const content = message?.content;
	if (!Array.isArray(content)) return out;
	for (const b of content) {
		if (!b || typeof b !== "object") continue;
		if (b.type === "toolCall" && b.arguments) {
			for (const key of ["path", "file", "pattern"]) {
				const v = b.arguments[key];
				if (typeof v === "string") scanText(v);
			}
			if (typeof b.arguments.command === "string") scanText(b.arguments.command);
			if (
				typeof b.arguments.command === "string" ||
				typeof b.arguments.path === "string"
			) {
				// also scan old/new text in edits for file mentions
			}
		}
		if (b.type === "text" && typeof b.text === "string") scanText(b.text);
	}
	return out;
}

function parseEnvelope(content) {
	const m = /<advisory\s+([^>]*)>([\s\S]*?)<\/advisory>/.exec(content ?? "");
	if (!m) return undefined;
	const sev = /severity="([^"]*)"/.exec(m[1])?.[1] ?? "concern";
	return { severity: sev, text: m[2] ?? "" };
}

const notes = []; // { session, severity, tDeliver, stalenessMs, activeMs, turnsBetween, matched }
let advisoryTotal = 0;
let sessionCount = 0;

/** Gaps longer than this between consecutive entries count as user idle, not advisor latency. */
const IDLE_GAP_MS = 3 * 60_000;

for (const file of walk(sessionsDir)) {
	const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
	const entries = [];
	for (const line of lines) {
		let d;
		try {
			d = JSON.parse(line);
		} catch {
			continue;
		}
		entries.push(d);
	}
	if (
		!entries.some(
			(e) => e.type === "custom_message" && e.customType === "advisory",
		)
	)
		continue;
	sessionCount++;

	// Chronological activity index: basename → { ts, assistantTurnsBefore }
	const lastTouch = new Map(); // basename → { ts, turnIdx }
	const activityTs = []; // every message timestamp, for idle-gap accounting
	let assistantTurns = 0;

	for (const e of entries) {
		const ts = Date.parse(e.timestamp ?? "");
		if (Number.isNaN(ts)) continue;

		if (e.type === "message" && e.message) {
			const role = e.message.role;
			if (role === "assistant") assistantTurns++;
			for (const base of pathsOfMessage(e.message)) {
				lastTouch.set(base, { ts, turnIdx: assistantTurns });
			}
			activityTs.push(ts);
			continue;
		}
		if (e.type === "custom_message" && e.customType === "advisory") {
			advisoryTotal++;
			const env = parseEnvelope(e.content);
			if (!env) continue;
			const refs = new Set();
			FILE_TOKEN_RE.lastIndex = 0;
			let m;
			while ((m = FILE_TOKEN_RE.exec(env.text)) !== null) {
				refs.add(basename(m[0].replace(/:\d+(?:,\d+)?$/, "")));
			}
			let best;
			for (const base of refs) {
				const touch = lastTouch.get(base);
				if (touch && (!best || touch.ts > best.ts)) best = touch;
			}
			// Active staleness subtracts every idle gap (user away >3min) in
			// the window — waiting for the user is not advisor latency.
			let activeMs;
			if (best) {
				let idle = 0;
				for (let k = activityTs.length - 1; k > 0; k--) {
					const cur = activityTs[k];
					if (cur <= best.ts) break;
					const gap = cur - activityTs[k - 1];
					if (gap > IDLE_GAP_MS) idle += gap;
				}
				// Gap between the last activity and the advisory itself.
				const tail = ts - (activityTs.at(-1) ?? ts);
				if (tail > IDLE_GAP_MS) idle += tail;
				activeMs = Math.max(0, ts - best.ts - idle);
			}
			notes.push({
				session: basename(file),
				severity: env.severity,
				tDeliver: ts,
				matched: best !== undefined,
				stalenessMs: best ? ts - best.ts : undefined,
				activeMs,
				turnsBetween: best ? assistantTurns - best.turnIdx : undefined,
			});
		}
	}
}

const pct = (xs, p) => {
	if (xs.length === 0) return undefined;
	const s = [...xs].sort((a, b) => a - b);
	return s[Math.min(s.length - 1, Math.floor((p / 100) * (s.length - 1)))];
};
const fmt = (ms) => {
	if (ms === undefined) return "?";
	if (ms < 1000) return `${ms}ms`;
	if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
	return `${(ms / 60_000).toFixed(1)}min`;
};

console.log(
	`sessions with advisories: ${sessionCount}, advisory notes: ${advisoryTotal}`,
);
const matched = notes.filter((n) => n.matched);
console.log(
	`notes with matchable file refs: ${matched.length} (${Math.round((matched.length / Math.max(1, notes.length)) * 100)}%)\n`,
);

const stale = matched.map((n) => n.stalenessMs);
const active = matched.map((n) => n.activeMs);
const turns = matched.map((n) => n.turnsBetween);
console.log("staleness (last activity on cited file → advisory delivered):");
console.log(
	`  wall:   p50=${fmt(pct(stale, 50))}  p90=${fmt(pct(stale, 90))}  max=${fmt(pct(stale, 100))}`,
);
console.log(
	`  active: p50=${fmt(pct(active, 50))}  p75=${fmt(pct(active, 75))}  p90=${fmt(pct(active, 90))}  max=${fmt(pct(active, 100))}  (wall minus idle gaps >${IDLE_GAP_MS / 60_000}min)`,
);
console.log("assistant turns between cited work and advisory:");
console.log(
	`  p50=${pct(turns, 50)}  p75=${pct(turns, 75)}  p90=${pct(turns, 90)}  max=${pct(turns, 100)}`,
);

const late = matched.filter((n) => n.activeMs > 300_000 && n.turnsBetween >= 3);
console.log(
	`\ngenuinely late (active >5min AND ≥3 turns since cited work): ${late.length} (${Math.round((late.length / Math.max(1, matched.length)) * 100)}%)`,
);
console.log(
	`  of which blocker: ${late.filter((n) => n.severity === "blocker").length}`,
);

const buckets = [
	["<30s", 0, 30_000],
	["30s–2min", 30_000, 120_000],
	["2–5min", 120_000, 300_000],
	["5–15min", 300_000, 900_000],
	[">15min", 900_000, Infinity],
];
console.log("\nhistogram:");
for (const [label, lo, hi] of buckets) {
	const n = stale.filter((x) => x >= lo && x < hi).length;
	const bar = "█".repeat(Math.round((n / Math.max(1, stale.length)) * 40));
	console.log(`  ${label.padEnd(10)} ${String(n).padStart(4)}  ${bar}`);
}

console.log("\nby severity (active p50 / p90, n):");
for (const sev of ["blocker", "concern", "nit"]) {
	const xs = matched.filter((n) => n.severity === sev).map((n) => n.activeMs);
	if (xs.length === 0) continue;
	console.log(
		`  ${sev.padEnd(8)} p50=${fmt(pct(xs, 50))}  p90=${fmt(pct(xs, 90))}  n=${xs.length}`,
	);
}

console.log("\nslowest 10 (matched) notes:");
for (const n of [...matched]
	.sort((a, b) => b.stalenessMs - a.stalenessMs)
	.slice(0, 10)) {
	console.log(
		`  ${fmt(n.stalenessMs).padStart(8)}  +${n.turnsBetween} turns  [${n.severity}]  ${n.session.slice(0, 16)}`,
	);
}
