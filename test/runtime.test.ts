import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	AdvisorRuntime,
	charBudgetOf,
	classifyFailure,
	extractPathHints,
	matchesFocus,
} from "../src/advisor/runtime.ts";
import { sliceEntries } from "../src/advisor/cursor.ts";
import type {
	AdvisorConfig,
	CompleteRequest,
	CompleteResult,
	Cursor,
	DeltaSlice,
	DeltaSource,
	Injector,
	ModelCaller,
	SessionEntryLike,
} from "../src/advisor/types.ts";

// ── fakes ──

function fakeSource(branch: SessionEntryLike[]): DeltaSource & { branch: SessionEntryLike[] } {
	return {
		branch,
		slice(cursor: Cursor): DeltaSlice {
			return sliceEntries(this.branch, cursor);
		},
		length(): number {
			return this.branch.length;
		},
	};
}

type Script =
	| { kind: "text"; text?: string }
	| { kind: "advise"; note: string; severity?: string; skipIf?: string }
	| { kind: "throw"; error: unknown };

function fakeCaller(script: Script[]): {
	caller: ModelCaller;
	requests: CompleteRequest[];
} {
	const requests: CompleteRequest[] = [];
	const queue = [...script];
	return {
		requests,
		caller: {
			complete(req: CompleteRequest): Promise<CompleteResult> {
				// Snapshot: runWithTools keeps pushing onto its messages array
				// after complete() returns; tests need the at-call-time view.
				requests.push({ ...req, messages: [...req.messages] });
				const next = queue.shift();
				if (!next) return Promise.resolve({ stopReason: "stop", content: [{ type: "text", text: "" }] });
				if (next.kind === "throw") return Promise.reject(next.error);
				if (next.kind === "advise") {
					return Promise.resolve({
						stopReason: "toolUse",
						content: [
							{
								type: "toolCall",
								id: "a1",
								name: "advise",
								arguments: { note: next.note, severity: next.severity ?? "concern", ...(next.skipIf ? { skipIf: next.skipIf } : {}) },
							},
						],
					});
				}
				return Promise.resolve({ stopReason: "stop", content: [{ type: "text", text: next.text ?? "" }] });
			},
		},
	};
}

interface Injection {
	channel: "steer" | "followUp" | "nit";
	text: string;
}

function fakeInjector(): { injector: Injector; log: Injection[] } {
	const log: Injection[] = [];
	return {
		log,
		injector: {
			steer: (text) => {
				log.push({ channel: "steer", text });
				return Promise.resolve();
			},
			followUp: (text) => {
				log.push({ channel: "followUp", text });
				return Promise.resolve();
			},
			enqueueNit: (text) => {
				log.push({ channel: "nit", text });
			},
		},
	};
}

function config(overrides: Partial<AdvisorConfig> = {}): AdvisorConfig {
	return {
		name: "TestAdvisor",
		slug: "test",
		model: "p/m",
		prompt: "You review.",
		tools: [],
		trigger: { frequency: "per-update", priority: "normal" },
		maxTokens: 80000,
		failurePolicy: "backoff",
		enabled: true,
		...overrides,
	};
}

function userEntry(text: string): SessionEntryLike {
	return { type: "message", message: { role: "user", content: [{ type: "text", text }] } };
}

const noSleep = () => Promise.resolve();

async function runTurn(
	rt: AdvisorRuntime,
	source: DeltaSource & { branch: SessionEntryLike[] },
	entries: SessionEntryLike[],
	turn: number,
) {
	source.branch.push(...entries);
	rt.onTurnEnd(turn);
	await rt.settle();
}

describe("AdvisorRuntime: happy path", () => {
	it("advise concern routes to followUp with advisory envelope", async () => {
		const source = fakeSource([]);
		const { caller } = fakeCaller([{ kind: "advise", note: "src/db.ts:45 string-concat SQL", severity: "concern" }]);
		const { injector, log } = fakeInjector();
		const rt = new AdvisorRuntime([config()], { source, caller, injector, cwd: "/tmp", sleep: noSleep });
		await runTurn(rt, source, [userEntry("fix the query")], 0);
		assert.equal(log.length, 1);
		assert.equal(log[0]!.channel, "followUp");
		assert.match(log[0]!.text, /<advisory advisor="TestAdvisor" severity="concern"/);
		assert.match(log[0]!.text, /src\/db\.ts:45/);
	});

	it("blocker steers, nit batches", async () => {
		const source = fakeSource([]);
		const { caller } = fakeCaller([
			{ kind: "advise", note: "critical issue here", severity: "blocker" },
			{ kind: "advise", note: "minor style thing", severity: "nit" },
		]);
		const { injector, log } = fakeInjector();
		const rt = new AdvisorRuntime([config()], { source, caller, injector, cwd: "/tmp", sleep: noSleep });
		await runTurn(rt, source, [userEntry("turn one")], 0);
		await runTurn(rt, source, [userEntry("turn two")], 1);
		assert.equal(log[0]!.channel, "steer");
		assert.equal(log[1]!.channel, "nit");
	});

	it("silent advisor injects nothing", async () => {
		const source = fakeSource([]);
		const { caller } = fakeCaller([{ kind: "text" }]);
		const { injector, log } = fakeInjector();
		const rt = new AdvisorRuntime([config()], { source, caller, injector, cwd: "/tmp", sleep: noSleep });
		await runTurn(rt, source, [userEntry("work")], 0);
		assert.equal(log.length, 0);
	});

	it("empty delta (no new entries) does not call the model", async () => {
		const source = fakeSource([]);
		const { caller, requests } = fakeCaller([]);
		const { injector } = fakeInjector();
		const rt = new AdvisorRuntime([config()], { source, caller, injector, cwd: "/tmp", sleep: noSleep });
		rt.onTurnEnd(0);
		await rt.settle();
		assert.equal(requests.length, 0);
	});

	it("dedupes repeated notes across turns", async () => {
		const source = fakeSource([]);
		const { caller } = fakeCaller([
			{ kind: "advise", note: "same issue" },
			{ kind: "advise", note: "same issue" },
		]);
		const { injector, log } = fakeInjector();
		const rt = new AdvisorRuntime([config()], { source, caller, injector, cwd: "/tmp", sleep: noSleep });
		await runTurn(rt, source, [userEntry("t1")], 0);
		await runTurn(rt, source, [userEntry("t2")], 1);
		assert.equal(log.length, 1);
	});
});

describe("AdvisorRuntime: cursor reset", () => {
	it("compaction re-renders full branch with reset prefix", async () => {
		const source = fakeSource([userEntry("old a"), userEntry("old b")]);
		const { caller, requests } = fakeCaller([{ kind: "text" }, { kind: "text" }]);
		const { injector } = fakeInjector();
		const rt = new AdvisorRuntime([config()], { source, caller, injector, cwd: "/tmp", sleep: noSleep });
		await runTurn(rt, source, [userEntry("old c")], 0);
		// Simulate compaction: branch shrinks.
		source.branch = [userEntry("fresh start")];
		await runTurn(rt, source, [], 1);
		assert.equal(requests.length, 2);
		const batch = requests[1]!.messages.at(-1) as { content: string };
		assert.match(batch.content, /advisor context was reset/);
		assert.match(batch.content, /fresh start/);
	});
});

describe("AdvisorRuntime: focus & frequency", () => {
	it("focus skips turns whose hints miss every glob", async () => {
		const source = fakeSource([]);
		const { caller, requests } = fakeCaller([{ kind: "text" }]);
		const { injector } = fakeInjector();
		const cfg = config({ focus: ["**/*.sql"] });
		const rt = new AdvisorRuntime([cfg], { source, caller, injector, cwd: "/tmp", sleep: noSleep });
		await runTurn(rt, source, [
			{ type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "1", name: "read", arguments: { path: "src/a.ts" } }] } },
		], 0);
		assert.equal(requests.length, 0, "ts file does not match **/*.sql");
		// Now a matching turn.
		await runTurn(rt, source, [
			{ type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "2", name: "read", arguments: { path: "db/schema.sql" } }] } },
		], 1);
		assert.equal(requests.length, 1);
	});

	it("ignore excludes matching hints", async () => {
		const cfg = config({ focus: ["**/*.ts"], ignore: ["**/test/**"] });
		const entries: SessionEntryLike[] = [
			{ type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "1", name: "read", arguments: { path: "src/test/x.ts" } }] } },
		];
		assert.equal(matchesFocus(cfg, entries), false);
	});

	it("per-N-turns triggers every N turns with content", async () => {
		const source = fakeSource([]);
		const { caller, requests } = fakeCaller([
			{ kind: "text" }, { kind: "text" }, { kind: "text" }, { kind: "text" },
		]);
		const { injector } = fakeInjector();
		const cfg = config({ trigger: { frequency: "per-N-turns", every: 2, priority: "normal" } });
		const rt = new AdvisorRuntime([cfg], { source, caller, injector, cwd: "/tmp", sleep: noSleep });
		for (let i = 0; i < 4; i++) await runTurn(rt, source, [userEntry(`turn ${i}`)], i);
		assert.equal(requests.length, 2, "turns 2 and 4 trigger");
	});
});

describe("AdvisorRuntime: failure classification & recovery", () => {
	it("classifyFailure maps errors", () => {
		assert.equal(classifyFailure({ status: 401, message: "unauthorized" }), "provider_permanent");
		assert.equal(classifyFailure({ status: 403, message: "forbidden" }), "provider_permanent");
		assert.equal(classifyFailure(new Error("model not found: xyz")), "provider_permanent");
		assert.equal(classifyFailure({ status: 429, message: "rate limited" }), "provider_transient");
		assert.equal(classifyFailure(new Error("context length exceeded")), "advisor_context");
		assert.equal(classifyFailure(new Error("content_filter triggered")), "classifier_refusal");
		assert.equal(classifyFailure({ name: "AbortError", message: "aborted" }), "timeout");
		assert.equal(classifyFailure(new Error("weird")), "provider_transient");
	});

	it("permanent failure halts the advisor and drops the queue", async () => {
		const source = fakeSource([]);
		const { caller, requests } = fakeCaller([{ kind: "throw", error: { status: 401, message: "bad key" } }]);
		const { injector, log } = fakeInjector();
		const rt = new AdvisorRuntime([config()], { source, caller, injector, cwd: "/tmp", sleep: noSleep });
		await runTurn(rt, source, [userEntry("t1")], 0);
		assert.equal(rt.get("test")!.halted, true);
		await runTurn(rt, source, [userEntry("t2")], 1);
		assert.equal(requests.length, 1, "halted advisor never calls again");
		assert.equal(log.length, 0);
	});

	it("transient failure backs off and retries the same batch", async () => {
		const source = fakeSource([]);
		const { caller, requests } = fakeCaller([
			{ kind: "throw", error: { status: 429, message: "slow down" } },
			{ kind: "advise", note: "recovered note" },
		]);
		const { injector, log } = fakeInjector();
		const rt = new AdvisorRuntime([config()], { source, caller, injector, cwd: "/tmp", sleep: noSleep });
		source.branch.push(userEntry("t1"));
		rt.onTurnEnd(0);
		await rt.settle();
		// settle() must also wait out the (instant) backoff re-kick.
		await rt.settle();
		assert.equal(requests.length, 2, "retried after backoff");
		assert.equal(log.length, 1);
		assert.equal(log[0]!.text.includes("recovered note"), true);
		assert.equal(rt.get("test")!.halted, false);
	});

	it("halt after maxConsecutiveFailures transient failures", async () => {
		const source = fakeSource([]);
		const { caller } = fakeCaller([
			{ kind: "throw", error: { status: 500, message: "x" } },
			{ kind: "throw", error: { status: 500, message: "x" } },
			{ kind: "throw", error: { status: 500, message: "x" } },
		]);
		const { injector } = fakeInjector();
		const rt = new AdvisorRuntime([config()], {
			source, caller, injector, cwd: "/tmp", sleep: noSleep, maxConsecutiveFailures: 3,
		});
		await runTurn(rt, source, [userEntry("t1")], 0);
		await rt.settle();
		assert.equal(rt.get("test")!.halted, true);
		assert.equal(rt.get("test")!.consecutiveFailures, 3);
	});

	it("/advisor reset lifts the halt latch and resumes", async () => {
		const source = fakeSource([]);
		const { caller, requests } = fakeCaller([
			{ kind: "throw", error: { status: 401, message: "bad key" } },
			{ kind: "advise", note: "back alive" },
		]);
		const { injector, log } = fakeInjector();
		const rt = new AdvisorRuntime([config()], { source, caller, injector, cwd: "/tmp", sleep: noSleep });
		await runTurn(rt, source, [userEntry("t1")], 0);
		assert.equal(rt.get("test")!.halted, true);
		rt.reset("test");
		await runTurn(rt, source, [userEntry("t2")], 1);
		assert.equal(rt.get("test")!.halted, false);
		assert.equal(requests.length, 2);
		assert.equal(log.length, 1);
	});

	it("classifier refusal: one retry, then halt", async () => {
		const source = fakeSource([]);
		const refusal = new Error("content_filter: blocked");
		const { caller, requests } = fakeCaller([
			{ kind: "throw", error: refusal },
			{ kind: "throw", error: refusal },
		]);
		const { injector } = fakeInjector();
		const rt = new AdvisorRuntime([config()], { source, caller, injector, cwd: "/tmp", sleep: noSleep });
		await runTurn(rt, source, [userEntry("t1")], 0);
		assert.equal(requests.length, 2, "retried exactly once");
		assert.equal(rt.get("test")!.halted, true);
	});

	it("context overflow clears history and retries the batch", async () => {
		const source = fakeSource([]);
		const { caller, requests } = fakeCaller([
			{ kind: "throw", error: new Error("maximum context length exceeded") },
			{ kind: "advise", note: "post-recovery note" },
		]);
		const { injector, log } = fakeInjector();
		const rt = new AdvisorRuntime([config()], { source, caller, injector, cwd: "/tmp", sleep: noSleep });
		await runTurn(rt, source, [userEntry("t1")], 0);
		assert.equal(requests.length, 2);
		assert.equal(log.length, 1);
		assert.equal(rt.get("test")!.halted, false);
	});

	it("exceptions never escape onTurnEnd/settle", async () => {
		const source = fakeSource([]);
		const caller: ModelCaller = {
			complete: () => Promise.reject(new Error("catastrophic weirdness")),
		};
		const { injector } = fakeInjector();
		const rt = new AdvisorRuntime([config()], { source, caller, injector, cwd: "/tmp", sleep: noSleep, maxConsecutiveFailures: 2 });
		rt.onTurnEnd(0); // must not throw synchronously
		await rt.settle(); // must not reject
		assert.ok(true);
	});
});

describe("AdvisorRuntime: maintainContext", () => {
	it("summarizes history when over budget", async () => {
		const source = fakeSource([]);
		const { caller, requests } = fakeCaller([
			{ kind: "advise", note: "first note" },
			{ kind: "text", text: "compressed state summary" }, // summarize call
			{ kind: "advise", note: "second note" },
		]);
		const { injector, log } = fakeInjector();
		// Tiny maxTokens → tiny char budget to force summarization.
		const cfg = config({ maxTokens: 1024 }); // budget = 3584 chars
		const rt = new AdvisorRuntime([cfg], { source, caller, injector, cwd: "/tmp", sleep: noSleep });
		await runTurn(rt, source, [userEntry("x".repeat(3000))], 0);
		await runTurn(rt, source, [userEntry("y".repeat(3000))], 1);
		assert.equal(log.length, 2);
		const summarizeReq = requests[1]!;
		assert.match(summarizeReq.systemPrompt, /Compress the following advisor review history/);
		// After summarize, the next batch's history starts with the summary.
		const thirdReq = requests[2]!;
		assert.match((thirdReq.messages[0] as { content: string }).content, /summary of earlier review/);
	});

	it("charBudget = maxTokens * 3.5", () => {
		assert.equal(charBudgetOf(config({ maxTokens: 80000 })), 280000);
	});
});

describe("extractPathHints", () => {
	it("pulls paths from tool args and text", () => {
		const hints = extractPathHints([
			{ type: "message", message: { role: "assistant", content: [
				{ type: "toolCall", id: "1", name: "read", arguments: { path: "src/a.ts" } },
				{ type: "text", text: "now editing lib/utils/helper.ts next" },
			] } },
		]);
		assert.ok(hints.includes("src/a.ts"));
		assert.ok(hints.includes("lib/utils/helper.ts"));
	});
});
