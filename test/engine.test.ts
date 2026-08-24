import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { ADVISE_TOOL_DEF, TOOL_RESULT_CAP, runWithTools } from "../src/advisor/engine.ts";
import type {
	CompleteRequest,
	CompleteResult,
	ContentBlock,
	ModelCaller,
	ToolExecutor,
} from "../src/advisor/types.ts";

/** Scripted ModelCaller: returns queued results in order. */
function scriptedCaller(...results: CompleteResult[]): {
	caller: ModelCaller;
	requests: CompleteRequest[];
} {
	const requests: CompleteRequest[] = [];
	const queue = [...results];
	return {
		requests,
		caller: {
			complete(req: CompleteRequest): Promise<CompleteResult> {
				requests.push(req);
				const next = queue.shift();
				if (!next) return Promise.reject(new Error("script exhausted"));
				return Promise.resolve(next);
			},
		},
	};
}

function textResult(text: string): CompleteResult {
	return { stopReason: "stop", content: [{ type: "text", text }] };
}

function toolUseResult(calls: { id: string; name: string; arguments: Record<string, unknown> }[]): CompleteResult {
	const content: ContentBlock[] = calls.map((c) => ({
		type: "toolCall",
		id: c.id,
		name: c.name,
		arguments: c.arguments,
	}));
	return { stopReason: "toolUse", content };
}

function echoExecutor(log: string[]): ToolExecutor {
	return {
		execute(name: string, args: Record<string, unknown>) {
			log.push(`${name}(${JSON.stringify(args)})`);
			return Promise.resolve({ content: `result-of-${name}` });
		},
	};
}

describe("runWithTools", () => {
	it("plain text response ends immediately, no notes", async () => {
		const { caller, requests } = scriptedCaller(textResult("all good"));
		const log: string[] = [];
		const res = await runWithTools(
			caller,
			{ systemPrompt: "sys", messages: [{ role: "user", content: "batch" }], tools: [] },
			echoExecutor(log),
		);
		assert.equal(res.notes.length, 0);
		assert.equal(res.endedBy, "stop");
		assert.equal(requests.length, 1);
		assert.equal(log.length, 0);
		assert.equal(res.usage.calls, 1);
	});

	it("advise call is collected, not executed, and ends the loop", async () => {
		const { caller, requests } = scriptedCaller(
			toolUseResult([
				{ id: "c1", name: "advise", arguments: { note: "unguarded eval in a.ts:9", severity: "blocker" } },
			]),
		);
		const log: string[] = [];
		const res = await runWithTools(
			caller,
			{ systemPrompt: "sys", messages: [], tools: [ADVISE_TOOL_DEF] },
			echoExecutor(log),
		);
		assert.equal(res.endedBy, "advise");
		assert.equal(res.notes.length, 1);
		assert.equal(res.notes[0]!.note, "unguarded eval in a.ts:9");
		assert.equal(res.notes[0]!.severity, "blocker");
		assert.equal(log.length, 0, "advise never hits the executor");
		assert.equal(requests.length, 1, "loop ends without another complete");
	});

	it("3-round loop: read → grep → advise, results fed back as toolResult messages", async () => {
		const { caller, requests } = scriptedCaller(
			toolUseResult([{ id: "r1", name: "read", arguments: { path: "a.ts" } }]),
			toolUseResult([{ id: "g1", name: "grep", arguments: { pattern: "eval" } }]),
			toolUseResult([{ id: "a1", name: "advise", arguments: { note: "found it", severity: "concern" } }]),
		);
		const log: string[] = [];
		const res = await runWithTools(
			caller,
			{ systemPrompt: "sys", messages: [{ role: "user", content: "batch" }], tools: [] },
			echoExecutor(log),
		);
		assert.equal(requests.length, 3);
		assert.deepEqual(log, ['read({"path":"a.ts"})', 'grep({"pattern":"eval"})']);
		// Round 2 request must contain round 1's toolResult.
		const round2Msgs = requests[1]!.messages;
		const tr = round2Msgs.find((m) => m.role === "toolResult");
		assert.ok(tr, "toolResult fed back");
		assert.equal((tr as { content?: string }).content, "result-of-read");
		assert.equal((tr as { toolCallId?: string }).toolCallId, "r1");
		assert.equal(res.notes.length, 1);
		assert.equal(res.endedBy, "advise");
		// newMessages: assistant, toolResult, assistant, toolResult, assistant
		assert.equal(res.newMessages.length, 5);
	});

	it("enforces the 8-round cap on endless tool use", async () => {
		const infinite = Array.from({ length: 20 }, (_, i) =>
			toolUseResult([{ id: `x${i}`, name: "read", arguments: { path: "f" } }]),
		);
		const { caller, requests } = scriptedCaller(...infinite);
		const res = await runWithTools(caller, { systemPrompt: "s", messages: [], tools: [] }, echoExecutor([]));
		assert.equal(requests.length, 8);
		assert.equal(res.endedBy, "roundCap");
	});

	it("tool results are truncated at the cap", async () => {
		const big = "y".repeat(TOOL_RESULT_CAP + 100);
		const { caller, requests } = scriptedCaller(
			toolUseResult([{ id: "b1", name: "read", arguments: { path: "big" } }]),
			textResult("done"),
		);
		const executor: ToolExecutor = {
			execute: () => Promise.resolve({ content: big }),
		};
		await runWithTools(caller, { systemPrompt: "s", messages: [], tools: [] }, executor);
		const tr = requests[1]!.messages.find((m) => m.role === "toolResult") as { content: string };
		assert.equal(tr.content.length, TOOL_RESULT_CAP + 1); // cap + ellipsis
	});

	it("invalid severity coerces to concern; empty note dropped", async () => {
		const { caller } = scriptedCaller(
			toolUseResult([
				{ id: "s1", name: "advise", arguments: { note: "real note", severity: "CRITICAL!!" } },
			]),
		);
		const res = await runWithTools(caller, { systemPrompt: "s", messages: [], tools: [] }, echoExecutor([]));
		assert.equal(res.notes[0]!.severity, "concern");

		const { caller: c2 } = scriptedCaller(
			toolUseResult([{ id: "s2", name: "advise", arguments: { note: "  ", severity: "nit" } }]),
			textResult("fallback"),
		);
		const res2 = await runWithTools(c2, { systemPrompt: "s", messages: [], tools: [] }, echoExecutor([]));
		assert.equal(res2.notes.length, 0);
	});

	it("skipIf is carried through", async () => {
		const { caller } = scriptedCaller(
			toolUseResult([
				{ id: "k1", name: "advise", arguments: { note: "tests failing", severity: "concern", skipIf: "tests failing" } },
			]),
		);
		const res = await runWithTools(caller, { systemPrompt: "s", messages: [], tools: [] }, echoExecutor([]));
		assert.equal(res.notes[0]!.skipIf, "tests failing");
	});

	it("accumulates usage across rounds", async () => {
		const r1 = toolUseResult([{ id: "u1", name: "ls", arguments: {} }]);
		r1.usage = { input: 100, output: 10 };
		const r2 = textResult("ok");
		r2.usage = { input: 200, output: 20 };
		const { caller } = scriptedCaller(r1, r2);
		const res = await runWithTools(caller, { systemPrompt: "s", messages: [], tools: [] }, echoExecutor([]));
		assert.deepEqual(res.usage, { input: 300, output: 30, calls: 2 });
	});
});

// ── tools.ts executor ──

describe("createReadonlyToolExecutor", async () => {
	const { createReadonlyToolExecutor, bashWriteViolation, matchGlob } = await import(
		"../src/advisor/tools.ts"
	);
	let dir: string;
	before(() => {
		dir = mkdtempSync(join(tmpdir(), "pi-advisor-tools-"));
		mkdirSync(join(dir, "src"), { recursive: true });
		writeFileSync(join(dir, "src", "a.ts"), "export const a = 1;\nexport const b = 2;\n");
		writeFileSync(join(dir, "README.md"), "# hello\nsecret marker line\n");
	});
	after(() => rmSync(dir, { recursive: true, force: true }));

	const all = ["read", "grep", "find", "ls", "bash"];

	it("read returns numbered lines", async () => {
		const ex = createReadonlyToolExecutor({ cwd: dir, allowedTools: all });
		const out = await ex.execute("read", { path: "src/a.ts" });
		assert.ok(out.content.includes("1\texport const a = 1;"));
		assert.ok(!out.isError);
	});

	it("read rejects path escape", async () => {
		const ex = createReadonlyToolExecutor({ cwd: dir, allowedTools: all });
		const out = await ex.execute("read", { path: "../../etc/passwd" });
		assert.ok(out.isError);
		assert.match(out.content, /escapes the workspace/);
	});

	it("grep finds matches with file:line", async () => {
		const ex = createReadonlyToolExecutor({ cwd: dir, allowedTools: all });
		const out = await ex.execute("grep", { pattern: "secret marker" });
		assert.match(out.content, /README\.md:2: secret marker line/);
	});

	it("grep rejects invalid regex", async () => {
		const ex = createReadonlyToolExecutor({ cwd: dir, allowedTools: all });
		const out = await ex.execute("grep", { pattern: "([[" });
		assert.ok(out.isError);
	});

	it("find matches globs", async () => {
		const ex = createReadonlyToolExecutor({ cwd: dir, allowedTools: all });
		const out = await ex.execute("find", { pattern: "**/*.ts" });
		assert.match(out.content, /src\/a\.ts/);
		assert.ok(!out.content.includes("README"));
	});

	it("ls lists entries with dir suffix", async () => {
		const ex = createReadonlyToolExecutor({ cwd: dir, allowedTools: all });
		const out = await ex.execute("ls", {});
		assert.match(out.content, /src\//);
		assert.match(out.content, /README\.md/);
	});

	it("ungranted tool is rejected", async () => {
		const ex = createReadonlyToolExecutor({ cwd: dir, allowedTools: ["read"] });
		const out = await ex.execute("grep", { pattern: "x" });
		assert.ok(out.isError);
		assert.match(out.content, /not granted/);
	});

	it("bash write-rejection matrix", () => {
		const cases: [string, RegExp][] = [
			["echo hi > out.txt", /redirection/],
			["echo hi >> out.txt", /redirection/],
			["rm -rf build", /rm/],
			["mv a b", /mv/],
			["echo x | tee f", /tee/],
			["sed -i s/a/b/ f", /sed -i/],
			["chmod +x f", /chmod/],
			["dd if=/dev/zero of=disk.img", /dd/],
			["mkfs /dev/sda", /mkfs/],
			["git commit -m x", /git mutation/],
			["npm install leftpad", /package mutation/],
		];
		for (const [cmd, re] of cases) {
			const v = bashWriteViolation(cmd);
			assert.ok(v, `expected rejection: ${cmd}`);
			assert.match(v, re, cmd);
		}
	});

	it("bash allows read-only commands", async () => {
		const ex = createReadonlyToolExecutor({
			cwd: dir,
			allowedTools: all,
			runShell: (cmd) => Promise.resolve(`ran: ${cmd}`),
		});
		assert.equal(bashWriteViolation("grep -r foo ."), undefined);
		assert.equal(bashWriteViolation("cat file | head -5"), undefined);
		const out = await ex.execute("bash", { command: "ls -la" });
		assert.ok(!out.isError);
		assert.match(out.content, /ran: ls -la/);
	});

	it("bash write command returns isError, not an exception", async () => {
		const ex = createReadonlyToolExecutor({ cwd: dir, allowedTools: all });
		const out = await ex.execute("bash", { command: "rm -rf /" });
		assert.ok(out.isError);
		assert.match(out.content, /read-only/);
	});

	it("matchGlob: ** crosses dirs, * stays within one", () => {
		assert.ok(matchGlob("**/*.ts", "src/deep/a.ts"));
		assert.ok(matchGlob("**/*.ts", "a.ts"));
		assert.ok(matchGlob("*.ts", "a.ts"));
		assert.ok(!matchGlob("*.ts", "src/a.ts"));
		assert.ok(matchGlob("src/**", "src/a/b/c.ts"));
		assert.ok(matchGlob("**/test/**", "x/test/y.ts"));
		assert.ok(!matchGlob("**/test/**", "x/tests/y.ts"));
	});
});
