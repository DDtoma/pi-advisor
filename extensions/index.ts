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
import { AdvisorRoster } from "../src/advisor/roster.ts";
import { createInjector, type PiInjector } from "../src/pi/inject.ts";
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
	let injector: PiInjector | undefined;

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
		try {
			const projectRoot = await detectProjectRoot(ctx);
			const rawInjector = createInjector(pi);
			// Debug build wraps injections with logging; the nit drain still
			// has to reach the raw queue, so keep a reference for draining.
			injector = DEBUG
				? {
						steer: (t) => {
							debugLog(`inject steer: ${t.slice(0, 160)}`);
							rawInjector.steer(t);
						},
						followUp: (t) => {
							debugLog(`inject followUp: ${t.slice(0, 160)}`);
							rawInjector.followUp(t);
						},
						enqueueNit: (t) => {
							debugLog(`inject nit: ${t.slice(0, 160)}`);
							rawInjector.enqueueNit(t);
						},
						drainNits: () => rawInjector.drainNits(),
						get nitDepth() {
							return rawInjector.nitDepth;
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
			});
			const report = roster.load();
			debugLog(`session_start: loaded ${report.advisorCount} advisor(s), errors=${report.errors.length} root=${projectRoot}`);
			for (const err of report.errors) {
				ctx.ui.notify(`pi-advisor config: ${err}`, "error");
			}
			if (report.advisorCount > 0) {
				ctx.ui.notify(`pi-advisor: ${report.advisorCount} advisor(s) watching`, "info");
			}
			updateStatusWidget(ctx);
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
			roster?.onTurnEnd(event.turnIndex);
			if (DEBUG) {
				void roster?.settle().then(() => {
					debugLog(`settled: ${roster?.status().map((s) => `${s.slug}(q=${s.queued},halt=${s.halted},calls=${s.usage.calls})`).join(" ")}`);
				});
			}
		} catch {
			// containment — never let an advisor error reach the primary loop
		}
	});

	pi.on("before_agent_start", () => {
		const batch = injector?.drainNits();
		if (!batch) return undefined;
		return {
			message: {
				customType: "advisory",
				content: batch,
				display: true,
			},
		};
	});

	// ── severity-colored rendering of injected advisory messages ──
	pi.registerMessageRenderer("advisory", (message, _opts, theme) => {
		const raw =
			typeof message.content === "string"
				? message.content
				: message.content
						.filter((b): b is { type: "text"; text: string } => b.type === "text")
						.map((b) => b.text)
						.join("\n");
		const colored = raw
			.split("\n")
			.map((line) => {
				const sev = /severity="(\w+)"/.exec(line)?.[1];
				if (sev === "blocker") return theme.fg("error", line);
				if (sev === "concern") return theme.fg("warning", line);
				if (sev === "nit") return theme.fg("muted", line);
				return theme.fg("customMessageText", line);
			})
			.join("\n");
		return new Text(`\n${colored}\n`, 1, 0);
	});

	// ── /advisor command ──
	pi.registerCommand("advisor", {
		description: "Watchdog advisors: status | next | now <slug> | off <slug> | on <slug> | reset [slug] | reload",
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
			if (!roster) {
				ctx.ui.notify("pi-advisor: not loaded (no session or startup failed)", "warning");
				return;
			}
			const [sub = "status", slug] = args.trim().split(/\s+/);
			switch (sub) {
				case "status": {
					updateStatusWidget(ctx);
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
					updateStatusWidget(ctx);
					return;
				}
				case "off":
				case "on": {
					if (!slug) {
						ctx.ui.notify(`usage: /advisor ${sub} <slug>`, "warning");
						return;
					}
					const ok = roster.setEnabled(slug, sub === "on");
					ctx.ui.notify(ok ? `${slug} ${sub === "on" ? "enabled" : "disabled"}` : `unknown advisor: ${slug}`, ok ? "info" : "warning");
					updateStatusWidget(ctx);
					return;
				}
				case "reset": {
					roster.reset(slug);
					ctx.ui.notify(slug ? `reset ${slug}` : "reset all advisors", "info");
					updateStatusWidget(ctx);
					return;
				}
				case "reload": {
					const report = roster.load();
					for (const err of report.errors) ctx.ui.notify(`pi-advisor config: ${err}`, "error");
					ctx.ui.notify(`reloaded: ${report.advisorCount} advisor(s)`, "info");
					updateStatusWidget(ctx);
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

	function updateStatusWidget(ctx: ExtensionContext): void {
		if (!roster || roster.status().length === 0) {
			ctx.ui.setWidget("advisor", undefined);
			return;
		}
		ctx.ui.setWidget("advisor", statusLines(roster));
	}
}
