#!/usr/bin/env node
/**
 * Parse /tmp/pi-advisor-debug.log and report per-stage advisor latency.
 *
 * Stages (per injected note):
 *   queue wait   — delta sat in the advisor queue (single-flight backlog)
 *   review       — advisor LLM call(s), incl. tool loop
 *   pi delivery  — steer-queued message waited for the next LLM-call boundary
 *   turn→inject  — turn_end to routeNote() (queue wait + review + guard)
 *   turn→context — turn_end to the message landing in the session (total)
 *
 * Usage: node scripts/analyze-latency.mjs [logfile]
 */
import { existsSync, readFileSync } from "node:fs";

const logfile = process.argv[2] ?? "/tmp/pi-advisor-debug.log";
if (!existsSync(logfile)) {
	console.log(`${logfile} not found — run pi with PI_ADVISOR_DEBUG=1 first`);
	process.exit(0);
}
const lines = readFileSync(logfile, "utf8").split("\n").filter(Boolean);

const ts = (line) => {
	const m = /^(\S+)\s/.exec(line);
	return m ? Date.parse(m[1]) : NaN;
};

// Per-advisor rolling state: the latest review window and its queue wait.
/** slug → { reviewStartTs, queueWaitMs, lastReviewMs } */
const windows = new Map();
/** note-prefix → { turnToInjectMs, injectTs, severity, slug } */
const pending = new Map();
const completed = []; // { slug, severity, queueWaitMs, reviewMs, piDeliveryMs, totalMs }

for (const line of lines) {
	const t = ts(line);
	if (Number.isNaN(t)) continue;

	let m = /event (\S+): reviewing with \S+ \((\d+) chars, queue wait (\d+)ms\)/.exec(line);
	if (m) {
		windows.set(m[1], { reviewStartTs: t, queueWaitMs: Number(m[3]), lastReviewMs: undefined });
		continue;
	}
	m = /event (\S+): reviewed: \d+ note\(s\), tokens ↑\d+ ↓\d+, review (\d+)ms/.exec(line);
	if (m) {
		const w = windows.get(m[1]);
		if (w) w.lastReviewMs = Number(m[2]);
		continue;
	}
	m = /event (\S+): injected \[(\w+)\] turn→inject (\d+)ms: (.*)/.exec(line);
	if (m) {
		pending.set(m[4].slice(0, 60), {
			slug: m[1],
			severity: m[2],
			turnToInjectMs: Number(m[3]),
			injectTs: t,
		});
		continue;
	}
	m = /delivered into context \[(\w+)\] \S+: (.*)/.exec(line);
	if (m) {
		const key = m[2].slice(0, 60);
		const p = pending.get(key);
		if (!p) continue;
		pending.delete(key);
		const w = windows.get(p.slug);
		completed.push({
			slug: p.slug,
			severity: p.severity,
			queueWaitMs: w?.queueWaitMs,
			reviewMs: w?.lastReviewMs,
			piDeliveryMs: t - p.injectTs,
			totalMs: p.turnToInjectMs + (t - p.injectTs),
		});
	}
}

const pct = (xs, p) => {
	if (xs.length === 0) return undefined;
	const s = [...xs].sort((a, b) => a - b);
	return s[Math.min(s.length - 1, Math.floor((p / 100) * (s.length - 1)))];
};
const fmt = (ms) => (ms === undefined || Number.isNaN(ms) ? "?" : ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`);

if (completed.length === 0) {
	console.log(`no completed advisory deliveries found in ${logfile}`);
	console.log("(need PI_ADVISOR_DEBUG=1 sessions with at least one injected note)");
	process.exit(0);
}

console.log(`stage latencies over ${completed.length} delivered note(s) from ${logfile}\n`);
for (const stage of ["queueWaitMs", "reviewMs", "piDeliveryMs", "totalMs"]) {
	const xs = completed.map((c) => c[stage]).filter((x) => x !== undefined);
	console.log(
		`${stage.replace("Ms", "").padEnd(12)} p50=${fmt(pct(xs, 50))}  p90=${fmt(pct(xs, 90))}  max=${fmt(pct(xs, 100))}`,
	);
}

console.log("\nper-note breakdown (slowest first):");
const rows = [...completed].sort((a, b) => b.totalMs - a.totalMs).slice(0, 20);
for (const c of rows) {
	console.log(
		`  ${c.slug}/${c.severity}  total=${fmt(c.totalMs)}  queue=${fmt(c.queueWaitMs)}  review=${fmt(c.reviewMs)}  pi-delivery=${fmt(c.piDeliveryMs)}`,
	);
}

if (pending.size > 0) {
	console.log(`\n${pending.size} note(s) injected but never seen in session (process ended before delivery, or dropped)`);
}
