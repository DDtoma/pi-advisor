/**
 * Read-only tool whitelist for advisors (architecture §2.2, ADR-004).
 *
 * Advisors may inspect the workspace but never modify it. Five tools:
 * read / grep / find / ls / bash. Every path argument is resolved against
 * cwd and rejected if it escapes. `bash` runs only commands that pass a
 * write-operation rejection matrix and is capped by timeout + output size.
 *
 * This module imports node builtins only (ADR-001) — no pi packages.
 */
import { execFile } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { resolve, sep } from "node:path";
import type { ToolDef, ToolExecutor } from "./types.ts";

export const READONLY_TOOL_NAMES = ["read", "grep", "find", "ls", "bash"] as const;

const MAX_GREP_MATCHES = 50;
const MAX_FIND_RESULTS = 200;
const MAX_LS_ENTRIES = 200;
const MAX_READ_LINES = 2000;
const MAX_LINE_CHARS = 500;
const BASH_TIMEOUT_MS = 10_000;
const MAX_OUTPUT_CHARS = 4000;

// ─────────────────────────── glob (shared with focus matching) ───────────

/** Minimal glob → RegExp: `**` crosses directories, `*` within one, `?` single char. */
export function globToRegex(glob: string): RegExp {
	let re = "";
	let i = 0;
	while (i < glob.length) {
		const ch = glob[i] as string;
		if (ch === "*") {
			if (glob[i + 1] === "*") {
				// `**/` also matches zero directories.
				if (glob[i + 2] === "/") {
					re += "(?:[^/]+/)*";
					i += 3;
				} else {
					re += ".*";
					i += 2;
				}
			} else {
				re += "[^/]*";
				i += 1;
			}
		} else if (ch === "?") {
			re += "[^/]";
			i += 1;
		} else {
			re += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
			i += 1;
		}
	}
	return new RegExp(`^${re}$`);
}

export function matchGlob(glob: string, path: string): boolean {
	return globToRegex(glob).test(path);
}

// ─────────────────────────── tool definitions ───────────────────────────

const TOOL_DEFS: Record<string, ToolDef> = {
	read: {
		name: "read",
		description: "Read a file (line-truncated). Path must stay inside the workspace.",
		parameters: {
			type: "object",
			properties: {
				path: { type: "string", description: "File path relative to the workspace root" },
				offset: { type: "number", description: "1-based starting line" },
				limit: { type: "number", description: "Max lines to return" },
			},
			required: ["path"],
		},
	},
	grep: {
		name: "grep",
		description: "Recursively search file contents with a regular expression.",
		parameters: {
			type: "object",
			properties: {
				pattern: { type: "string", description: "Regular expression" },
				path: { type: "string", description: "Subdirectory or file to search (default: root)" },
			},
			required: ["pattern"],
		},
	},
	find: {
		name: "find",
		description: "Find files whose workspace-relative path matches a glob.",
		parameters: {
			type: "object",
			properties: {
				pattern: { type: "string", description: "Glob, e.g. **/*.ts" },
				path: { type: "string", description: "Subdirectory to search (default: root)" },
			},
			required: ["pattern"],
		},
	},
	ls: {
		name: "ls",
		description: "List directory entries.",
		parameters: {
			type: "object",
			properties: { path: { type: "string", description: "Directory (default: root)" } },
		},
	},
	bash: {
		name: "bash",
		description:
			"Run a READ-ONLY shell command in the workspace. Write operations (>, rm, mv, tee, sed -i, chmod, dd, mkfs, ...) are rejected.",
		parameters: {
			type: "object",
			properties: { command: { type: "string" } },
			required: ["command"],
		},
	},
};

export function toolDefsFor(allowed: readonly string[]): ToolDef[] {
	return allowed.map((name) => TOOL_DEFS[name]).filter((d): d is ToolDef => d !== undefined);
}

// ─────────────────────────── bash write-operation rejection ───────────

const WRITE_PATTERNS: { re: RegExp; what: string }[] = [
	{ re: /(^|[^>])>+/, what: "output redirection (>)" },
	{ re: /\brm\b/, what: "rm" },
	{ re: /\bmv\b/, what: "mv" },
	{ re: /\bcp\b/, what: "cp" },
	{ re: /\btee\b/, what: "tee" },
	{ re: /\bsed\s+(-\S*\s*)*-i/, what: "sed -i" },
	{ re: /\bchmod\b/, what: "chmod" },
	{ re: /\bchown\b/, what: "chown" },
	{ re: /\bdd\b/, what: "dd" },
	{ re: /\bmkfs\b/, what: "mkfs" },
	{ re: /\btouch\b/, what: "touch" },
	{ re: /\bmkdir\b/, what: "mkdir" },
	{ re: /\brmdir\b/, what: "rmdir" },
	{ re: /\b(npm|yarn|pnpm|bun)\s+(install|add|remove|publish)\b/, what: "package mutation" },
	{ re: /\bgit\s+(add|commit|push|reset|checkout|restore|clean|merge|rebase)\b/, what: "git mutation" },
];

export function bashWriteViolation(command: string): string | undefined {
	for (const { re, what } of WRITE_PATTERNS) {
		if (re.test(command)) return what;
	}
	return undefined;
}

// ─────────────────────────── executor ───────────────────────────

export interface ReadonlyToolExecutorOptions {
	cwd: string;
	allowedTools: readonly string[];
	/** Injected for tests; defaults to execFile-backed shell. */
	runShell?: (command: string, cwd: string, timeoutMs: number) => Promise<string>;
}

export function createReadonlyToolExecutor(opts: ReadonlyToolExecutorOptions): ToolExecutor {
	const cwd = resolve(opts.cwd);
	const allowed = new Set(opts.allowedTools);
	const runShell = opts.runShell ?? defaultRunShell;

	function safeResolve(pathArg: unknown): string {
		if (typeof pathArg !== "string" || !pathArg) {
			throw new ToolError("path argument is required");
		}
		const abs = resolve(cwd, pathArg);
		if (abs !== cwd && !abs.startsWith(cwd + sep)) {
			throw new ToolError(`path escapes the workspace: ${pathArg}`);
		}
		return abs;
	}

	function rel(abs: string): string {
		return abs === cwd ? "." : abs.slice(cwd.length + 1);
	}

	function walk(dirAbs: string, out: string[] = []): string[] {
		let entries;
		try {
			entries = readdirSync(dirAbs, { withFileTypes: true });
		} catch {
			return out;
		}
		for (const e of entries) {
			if (e.name === "node_modules" || e.name === ".git") continue;
			const full = `${dirAbs}${sep}${e.name}`;
			if (e.isDirectory()) walk(full, out);
			else if (e.isFile()) out.push(full);
			if (out.length > 20_000) break; // pathological trees
		}
		return out;
	}

	async function execute(name: string, args: Record<string, unknown>) {
		if (!allowed.has(name)) {
			return { content: `tool "${name}" is not granted to this advisor`, isError: true };
		}
		try {
			switch (name) {
				case "read": {
					const abs = safeResolve(args["path"]);
					const text = readFileSync(abs, "utf8");
					const lines = text.split("\n");
					const offset = Math.max(1, Number(args["offset"] ?? 1));
					const limit = Math.min(Number(args["limit"] ?? MAX_READ_LINES), MAX_READ_LINES);
					const slice = lines.slice(offset - 1, offset - 1 + limit);
					const numbered = slice.map((l, i) => {
						const truncated = l.length > MAX_LINE_CHARS ? `${l.slice(0, MAX_LINE_CHARS)}…` : l;
						return `${offset + i}\t${truncated}`;
					});
					let content = numbered.join("\n");
					if (offset - 1 + slice.length < lines.length) {
						content += `\n[… ${lines.length - (offset - 1 + slice.length)} more lines]`;
					}
					return { content: content || "(empty file)" };
				}
				case "grep": {
					const pattern = args["pattern"];
					if (typeof pattern !== "string" || !pattern) throw new ToolError("pattern is required");
					let re: RegExp;
					try {
						re = new RegExp(pattern);
					} catch {
						throw new ToolError(`invalid regex: ${pattern}`);
					}
					const base = args["path"] !== undefined ? safeResolve(args["path"]) : cwd;
					const files = statSync(base, { throwIfNoEntry: false })?.isDirectory() ? walk(base) : [base];
					const matches: string[] = [];
					for (const file of files) {
						if (matches.length >= MAX_GREP_MATCHES) break;
						let text: string;
						try {
							text = readFileSync(file, "utf8");
						} catch {
							continue; // binary / unreadable
						}
						const lines = text.split("\n");
						for (let i = 0; i < lines.length; i++) {
							if (re.test(lines[i] as string)) {
								const lineText = (lines[i] as string).slice(0, MAX_LINE_CHARS);
								matches.push(`${rel(file)}:${i + 1}: ${lineText}`);
								if (matches.length >= MAX_GREP_MATCHES) break;
							}
						}
					}
					return {
						content:
							matches.length === 0
								? "(no matches)"
								: matches.join("\n") +
									(matches.length >= MAX_GREP_MATCHES ? `\n[… capped at ${MAX_GREP_MATCHES} matches]` : ""),
					};
				}
				case "find": {
					const pattern = args["pattern"];
					if (typeof pattern !== "string" || !pattern) throw new ToolError("pattern is required");
					const re = globToRegex(pattern);
					const base = args["path"] !== undefined ? safeResolve(args["path"]) : cwd;
					const found = walk(base)
						.map(rel)
						.filter((p) => re.test(p))
						.slice(0, MAX_FIND_RESULTS);
					return { content: found.length === 0 ? "(no files)" : found.join("\n") };
				}
				case "ls": {
					const abs = args["path"] !== undefined ? safeResolve(args["path"]) : cwd;
					const entries = readdirSync(abs, { withFileTypes: true })
						.slice(0, MAX_LS_ENTRIES)
						.map((e) => (e.isDirectory() ? `${e.name}/` : e.name));
					return { content: entries.join("\n") || "(empty directory)" };
				}
				case "bash": {
					const command = args["command"];
					if (typeof command !== "string" || !command.trim()) {
						throw new ToolError("command is required");
					}
					const violation = bashWriteViolation(command);
					if (violation) {
						return {
							content: `rejected: write operation detected (${violation}). Advisors are read-only.`,
							isError: true,
						};
					}
					const out = await runShell(command, cwd, BASH_TIMEOUT_MS);
					return { content: out.slice(0, MAX_OUTPUT_CHARS) || "(no output)" };
				}
				default:
					return { content: `unknown tool: ${name}`, isError: true };
			}
		} catch (err) {
			if (err instanceof ToolError) return { content: `error: ${err.message}`, isError: true };
			const msg = err instanceof Error ? err.message : String(err);
			return { content: `error: ${msg}`.slice(0, MAX_OUTPUT_CHARS), isError: true };
		}
	}

	return { execute };
}

class ToolError extends Error {}

function defaultRunShell(command: string, cwd: string, timeoutMs: number): Promise<string> {
	return new Promise((resolvePromise, rejectPromise) => {
		execFile(
			"/bin/sh",
			["-c", command],
			{ cwd, timeout: timeoutMs, maxBuffer: 1024 * 1024 },
			(err, stdout, stderr) => {
				if (err && !stdout && !stderr) {
					rejectPromise(new Error(err.message));
					return;
				}
				resolvePromise(`${stdout}${stderr ? `\n[stderr] ${stderr}` : ""}`.trim());
			},
		);
	});
}
