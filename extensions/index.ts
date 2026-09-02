/**
 * pi-advisor composition root (implementation-plan Step 8).
 *
 * All event handlers are fire-and-forget (ADR-003): advisor failures must
 * never surface into the primary agent's event loop. Everything pi-facing
 * lives here and in src/pi/*; src/advisor/* stays pi-free (ADR-001).
 *
 * Commands: /advisor status | next | now <slug> | off <slug> | on <slug>
 *           | reset [slug] | reload
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { execFile } from "node:child_process";
import { appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseAdvisories } from "../src/advisor/router.ts";
import { AdvisorRoster } from "../src/advisor/roster.ts";
import type { Injector, Severity } from "../src/advisor/types.ts";
import { createInjector } from "../src/pi/inject.ts";
import { createModelCaller } from "../src/pi/model-caller.ts";
import { createSessionSource } from "../src/pi/session-source.ts";

const GLOBAL_CONFIG = join(homedir(), ".pi", "agent", "WATCHDOG.yml");

/** PI_ADVISOR_DEBUG=1 appends lifecycle traces to /tmp/pi-advisor-debug.log. */
const DEBUG = !!process.env.PI_ADVISOR_DEBUG;
function debugLog(line: string): void {
	if (!DEBUG) return;
	try {
		appendFileSync("/tmp/pi-advisor-debug.log", `${new Date().toISOString()} ${line}\n`);
	} catch {
		// debug logging must never break anything
	}
}

export default function piAdvisor(pi: ExtensionAPI): void {
	let roster: AdvisorRoster | undefined;
	let injector: Injector | undefined;
	let lastCtx: ExtensionContext | undefined;
	let debugMode = false;

	/** Runtime lifecycle observer: always trace to the debug log; when debug mode is on, also notify. */
	function onAdvisorEvent(slug: string, message: string): void {
		debugLog(`event ${slug}: ${message}`);
		if (debugMode) lastCtx?.ui.notify(`advisor ${slug}: ${message}`, "info");
	}

	async function detectProjectRoot(ctx: ExtensionContext): Promise<string> {
		// Note: ctx.exec exists only on command contexts, so use node here.
		return new Promise((resolvePromise) => {
			execFile("git", ["rev-parse", "--show-toplevel"], { cwd: ctx.cwd, timeout: 5000 }, (err, stdout) => {
				const root = stdout.trim();
				resolvePromise(!err && root ? root : ctx.cwd);
			});
		});
	}

	pi.on("session_start", async (_event, ctx) => {
		lastCtx = ctx;
		try {
			const projectRoot = await detectProjectRoot(ctx);
			const rawInjector = createInjector(pi);
			// Debug build wraps injections with logging.
			injector = DEBUG
				? {
					steer: (t, details) => {
						debugLog(`inject steer: ${t.slice(0, 160)}`);
						rawInjector.steer(t, details);
					},
				}
				: rawInjector;
			const caller = createModelCaller(ctx.modelRegistry);
			roster = new AdvisorRoster({
				source: createSessionSource(ctx.sessionManager),
				caller: DEBUG
					? {
							complete: async (req) => {
								debugLog(`complete model=${req.modelSpec} messages=${req.messages.length}`);
								try {
									const res = await caller.complete(req);
									debugLog(`complete ok stopReason=${res.stopReason}`);
									return res;
								} catch (err) {
									debugLog(`complete FAILED: ${err instanceof Error ? err.message : err}`);
									throw err;
								}
							},
						}
					: caller,
				injector,
				cwd: ctx.cwd,
				globalConfigPath: GLOBAL_CONFIG,
				projectRoot,
				onEvent: onAdvisorEvent,
			});
			const report = roster.load();
			debugLog(`session_start: loaded ${report.advisorCount} advisor(s), errors=${report.errors.length} root=${projectRoot}`);
			for (const err of report.errors) {
				ctx.ui.notify(`pi-advisor config: ${err}`, "error");
			}
			if (report.advisorCount > 0) {
				ctx.ui.notify(`pi-advisor: ${report.advisorCount} advisor(s) watching`, "info");
			}
		} catch (err) {
			// Containment: a broken advisor system must never break the session.
			ctx.ui.notify(`pi-advisor failed to start: ${err instanceof Error ? err.message : err}`, "warning");
			roster = undefined;
		}
	});

	pi.on("session_compact", () => {
		roster?.resetContexts();
	});

	pi.on("session_shutdown", () => {
		roster?.dispose();
		roster = undefined;
		injector = undefined;
	});

	pi.on("turn_end", (event) => {
		try {
			debugLog(`turn_end ${event.turnIndex}`);
			const r = roster;
			r?.onTurnEnd(event.turnIndex);
			if (DEBUG && r) {
				void r.settle().then(() => {
					debugLog(`settled: ${r.status().map((s) => `${s.slug}(q=${s.queued},halt=${s.halted},calls=${s.usage.calls})`).join(" ")}`);
				});
			}
		} catch {
			// containment — never let an advisor error reach the primary loop
		}
	});

	// Latency instrumentation, final hop: a steer-queued advisory only enters
	// the session (and thus the LLM context) when the agent loop pulls it
	// before the next LLM call. message_end for the custom advisory message
	// marks that moment — diff its log timestamp against the runtime's
	// `injected ... turn→inject` line to get pi-internal delivery delay.
	pi.on("message_end", (event) => {
		try {
			const msg = event.message as { role?: string; customType?: string; content?: unknown };
			if (msg.role !== "custom" || msg.customType !== "advisory") return;
			const text =
				typeof msg.content === "string"
					? msg.content
					: Array.isArray(msg.content)
						? (msg.content as { type?: string; text?: string }[])
								.filter((b) => b.type === "text")
								.map((b) => b.text ?? "")
								.join("\n")
						: "";
			const env = parseAdvisories(text)[0];
			debugLog(
				env
					? `delivered into context [${env.severity}] ${env.advisor}: ${env.text.slice(0, 80)}`
					: `delivered into context: ${text.slice(0, 80)}`,
			);
		} catch {
			// containment
		}
	});
	// ── severity-badged rendering of injected advisory messages ──
	// Every advisory arrives as a steer-delivered customType "advisory"
	// message, so one renderer badges every severity uniformly.
	// concern deliberately avoids the theme "warning" token: most themes map
	// it to bright yellow (#ffff00), which is unreadable on light terminal
	// backgrounds. A fixed dark orange (256-color #d75f00) stays legible on
	// both light and dark backgrounds.
	const ORANGE_FG = "\x1b[38;5;166m";
	const RESET_FG = "\x1b[39m";
	const SEVERITY_COLOR: Record<Severity, "muted" | "error" | "orange"> = {
		nit: "muted",
		concern: "orange",
		blocker: "error",
	};
	pi.registerMessageRenderer("advisory", (message, opts, theme) => {
		const raw =
			typeof message.content === "string"
				? message.content
				: message.content
						.filter((b): b is { type: "text"; text: string } => b.type === "text")
						.map((b) => b.text)
						.join("\n");
		const envelopes = parseAdvisories(raw);
		if (envelopes.length === 0) {
			// Shouldn't happen — but render something rather than nothing.
			return new Text(`\n${theme.fg("customMessageText", raw)}\n`, 1, 0);
		}
		const lines: string[] = [];
		for (const env of envelopes) {
		const color = SEVERITY_COLOR[env.severity];
		const paint = (text: string): string =>
			color === "orange" ? `${ORANGE_FG}${text}${RESET_FG}` : theme.fg(color, text);
		lines.push(paint(theme.bold(`[${env.severity.toUpperCase()}] ${env.advisor}`)));
		for (const line of env.text.split("\n")) {
			lines.push(paint(line));
		}
		}
		// A clamped note carries its untruncated text in message.details (never
		// in LLM context). Collapsed: one hint line. Expanded (tools-expand key,
		// default ctrl+o): the full text.
		const fullNote = (message.details as { fullNote?: unknown } | undefined)?.fullNote;
		if (typeof fullNote === "string" && fullNote) {
			if (opts.expanded) {
				lines.push(theme.fg("muted", "── full note ──"));
				for (const line of fullNote.split("\n")) {
					lines.push(theme.fg("muted", line));
				}
			} else {
				lines.push(theme.fg("muted", "[truncated — expand to view full note]"));
			}
		}
		return new Text(`\n${lines.join("\n")}\n`, 1, 0);
	});

	// ── /advisor command ──
	pi.registerCommand("advisor", {
		description: "Watchdog advisors: status | next | now <slug> | off <slug> | on <slug> | reset [slug] | reload | debug [on|off]",
		getArgumentCompletions: (prefix) => {
			const subs = ["status", "next", "now", "off", "on", "reset", "reload"];
			const parts = prefix.split(/\s+/);
			if (parts.length <= 1) {
				return subs.filter((s) => s.startsWith(parts[0] ?? "")).map((s) => ({ value: s, label: s }));
			}
			const slugs = roster?.status().map((s) => s.slug) ?? [];
			return slugs
				.filter((s) => s.startsWith(parts[1] ?? ""))
				.map((s) => ({ value: `${parts[0]} ${s}`, label: s }));
		},
		handler: async (args, ctx) => {
			lastCtx = ctx;
			if (!roster) {
				ctx.ui.notify("pi-advisor: not loaded (no session or startup failed)", "warning");
				return;
			}
			const [sub = "status", slug] = args.trim().split(/\s+/);
			switch (sub) {
				case "status": {
					const lines = statusLines(roster);
					ctx.ui.notify(lines.length > 0 ? lines.join("\n") : "no advisors configured", "info");
					return;
				}
				case "next": {
					const preview = roster.previewNext();
					ctx.ui.notify(
						preview.length === 0
							? "no advisors configured"
							: preview.map((p) => `${p.wouldTrigger ? "●" : "○"} ${p.slug} — ${p.reason}`).join("\n"),
						"info",
					);
					return;
				}
				case "now": {
					if (!slug) {
						ctx.ui.notify("usage: /advisor now <slug>", "warning");
						return;
					}
					const msg = roster.forceTrigger(slug);
					ctx.ui.notify(msg, msg.startsWith("triggered") ? "info" : "warning");
					await roster.settle();
					return;
				}
				case "off":
				case "on": {
					const enable = sub === "on";
					if (!slug) {
						// No slug → apply to every advisor.
						const all = roster.status().map((s) => s.slug);
						for (const s of all) roster.setEnabled(s, enable);
						ctx.ui.notify(`all advisors ${enable ? "enabled" : "disabled"} (${all.length})`, "info");
						return;
					}
					const ok = roster.setEnabled(slug, enable);
					ctx.ui.notify(ok ? `${slug} ${enable ? "enabled" : "disabled"}` : `unknown advisor: ${slug}`, ok ? "info" : "warning");
					return;
				}
				case "reset": {
					roster.reset(slug);
					ctx.ui.notify(slug ? `reset ${slug}` : "reset all advisors", "info");
					return;
				}
				case "debug": {
					const arg = slug?.toLowerCase();
					if (arg === "on") debugMode = true;
					else if (arg === "off") debugMode = false;
					else debugMode = !debugMode;
					ctx.ui.notify(
						`advisor debug mode: ${debugMode ? "on — every advisor event will be shown as a notification" : "off"}`,
						"info",
					);
					return;
				}
				case "reload": {
					const report = roster.load();
					for (const err of report.errors) ctx.ui.notify(`pi-advisor config: ${err}`, "error");
					ctx.ui.notify(`reloaded: ${report.advisorCount} advisor(s)`, "info");
					return;
				}
				default:
					ctx.ui.notify(`unknown subcommand "${sub}" — try /advisor status`, "warning");
			}
		},
	});

	function statusLines(r: AdvisorRoster): string[] {
		return r.status().map((s) => {
			const flags = [s.enabled ? "on" : "off", s.halted ? "HALTED" : ""].filter(Boolean).join(",");
			const budgetPct = s.charBudget > 0 ? Math.round((s.historyChars / s.charBudget) * 100) : 0;
			return (
				`${s.slug} [${flags}] queue=${s.queued} rev=${s.revision} ` +
				`fails=${s.consecutiveFailures} budget=${budgetPct}% ` +
				`usage=${s.usage.input}↑/${s.usage.output}↓ (${s.usage.calls} calls)`
			);
		});
	}
}
