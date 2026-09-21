/**
 * WATCHDOG.yml loading: minimal YAML subset parser + schema validation
 * (architecture §5, ADR-007).
 *
 * The parser deliberately supports ONLY what the config schema needs:
 * nested maps (space indentation), sequences (`- item`), scalars
 * (string/number/boolean/null), inline flow lists (`[a, "b"]`), literal
 * block strings (`|` / `|-`), and comments. No anchors, tags, or
 * multi-line flow scalars. Zero runtime dependencies is the distribution
 * goal — pi extension dependency resolution is fragile (packages.md).
 *
 * Validation is fail-fast with line numbers: unknown version, duplicate
 * slugs, malformed model refs, over-budget prompts, bad globs all throw
 * ConfigError at load time.
 */
import { readFileSync } from "node:fs";
import type {
	AdvisorConfig,
	ReadonlyToolName,
	TriggerConfig,
} from "./types.ts";

export class ConfigError extends Error {
	readonly line: number | undefined;
	constructor(message: string, line?: number) {
		super(line === undefined ? message : `line ${line}: ${message}`);
		this.name = "ConfigError";
		this.line = line;
	}
}

// ─────────────────────────── YAML subset parser ───────────────────────────

type YamlValue =
	| string
	| number
	| boolean
	| null
	| YamlValue[]
	| { [k: string]: YamlValue };

interface RawLine {
	num: number; // 1-based
	raw: string; // the full source line, untouched
}

interface StructuralLine {
	num: number;
	indent: number;
	text: string; // trimmed, trailing comment stripped
}

function rawLines(text: string): RawLine[] {
	return text.split("\n").map((raw, i) => ({ num: i + 1, raw }));
}

function isBlank(raw: string): boolean {
	return raw.trim() === "";
}

function isComment(raw: string): boolean {
	return raw.trimStart().startsWith("#");
}

function stripTrailingComment(text: string): string {
	// A `#` preceded by whitespace starts a comment — unless inside quotes.
	let quote: string | undefined;
	for (let i = 0; i < text.length; i++) {
		const ch = text[i] as string;
		if (quote) {
			if (ch === quote) quote = undefined;
			continue;
		}
		if (ch === '"' || ch === "'") quote = ch;
		else if (ch === "#" && i > 0 && /\s/.test(text[i - 1] as string)) {
			return text.slice(0, i).trimEnd();
		}
	}
	return text;
}

class Parser {
	private pos = 0;
	private lines: RawLine[];
	constructor(lines: RawLine[]) {
		this.lines = lines;
	}

	parse(): YamlValue {
		const first = this.nextStructural();
		if (!first) return null;
		const value = this.parseNode(first.indent);
		const extra = this.nextStructural();
		if (extra) throw new ConfigError("unexpected content", extra.num);
		return value;
	}

	/** Advance past blank/comment lines; return the next structural line. */
	private nextStructural(): StructuralLine | undefined {
		for (;;) {
			const line = this.lines[this.pos];
			if (!line) return undefined;
			if (isBlank(line.raw) || isComment(line.raw)) {
				this.pos++;
				continue;
			}
			const indent = line.raw.length - line.raw.trimStart().length;
			if (/\t/.test(line.raw.slice(0, indent))) {
				throw new ConfigError("tab indentation is not supported", line.num);
			}
			return {
				num: line.num,
				indent,
				text: stripTrailingComment(line.raw.trim()),
			};
		}
	}

	/** Peek at the next structural line WITHOUT consuming it. */
	private peekStructural(): StructuralLine | undefined {
		const saved = this.pos;
		const line = this.nextStructural();
		this.pos = saved;
		return line;
	}

	/** Consume and return the next structural line. */
	private takeStructural(): StructuralLine | undefined {
		const line = this.nextStructural();
		if (line) this.pos++;
		return line;
	}

	private parseNode(indent: number): YamlValue {
		const line = this.peekStructural();
		if (!line || line.indent < indent) return null;
		if (line.indent > indent) {
			throw new ConfigError("unexpected indentation", line.num);
		}
		if (line.text === "-" || line.text.startsWith("- "))
			return this.parseSeq(indent);
		return this.parseMap(indent);
	}

	private parseMap(indent: number): YamlValue {
		const map: { [k: string]: YamlValue } = {};
		for (;;) {
			const line = this.peekStructural();
			if (
				!line ||
				line.indent !== indent ||
				line.text === "-" ||
				line.text.startsWith("- ")
			)
				break;
			const m = /^([^\s:][^:]*):\s*(.*)$/.exec(line.text);
			if (!m)
				throw new ConfigError(
					`expected "key: value", got "${line.text}"`,
					line.num,
				);
			this.takeStructural();
			map[m[1]!.trim()] = this.parseValueAfterKey(m[2]!, indent, line.num);
		}
		return map;
	}

	private parseSeq(indent: number): YamlValue {
		const list: YamlValue[] = [];
		for (;;) {
			const line = this.peekStructural();
			if (
				!line ||
				line.indent !== indent ||
				!(line.text === "-" || line.text.startsWith("- "))
			)
				break;
			const rest = line.text === "-" ? "" : line.text.slice(2).trimStart();
			this.takeStructural();
			if (!rest) {
				// Nested node on following, more-indented lines.
				const next = this.peekStructural();
				if (next && next.indent > indent) list.push(this.parseNode(next.indent));
				else list.push(null);
				continue;
			}
			if (/^[^\s:][^:]*:(\s|$)/.test(rest)) {
				// Map item: "- key: value" with continuation keys aligned at
				// the column where the key started (dash + space = +2).
				const itemIndent = indent + 2;
				const map: { [k: string]: YamlValue } = {};
				const m = /^([^\s:][^:]*):\s*(.*)$/.exec(rest)!;
				map[m[1]!.trim()] = this.parseValueAfterKey(m[2]!, itemIndent, line.num);
				for (;;) {
					const cont = this.peekStructural();
					if (!cont || cont.indent !== itemIndent || cont.text.startsWith("- "))
						break;
					const cm = /^([^\s:][^:]*):\s*(.*)$/.exec(cont.text);
					if (!cm)
						throw new ConfigError(
							`expected "key: value", got "${cont.text}"`,
							cont.num,
						);
					this.takeStructural();
					map[cm[1]!.trim()] = this.parseValueAfterKey(cm[2]!, itemIndent, cont.num);
				}
				list.push(map);
				continue;
			}
			list.push(parseScalar(rest, line.num));
		}
		return list;
	}

	private parseValueAfterKey(
		rest: string,
		keyIndent: number,
		keyLine: number,
	): YamlValue {
		if (rest === "|" || rest === "|-" || rest === "|+") {
			return this.parseBlockString(
				keyIndent,
				rest === "|-" ? "strip" : rest === "|+" ? "keep" : "clip",
			);
		}
		if (rest === "") {
			const next = this.peekStructural();
			if (next && next.indent > keyIndent) return this.parseNode(next.indent);
			return null;
		}
		return parseScalar(rest, keyLine);
	}

	private parseBlockString(
		parentIndent: number,
		chomp: "strip" | "clip" | "keep",
	): string {
		// Reads RAW lines so blank lines, leading whitespace, and `#` inside
		// block content are preserved literally.
		const collected: string[] = [];
		let blockIndent = -1;
		for (;;) {
			const line = this.lines[this.pos];
			if (!line) break;
			if (isBlank(line.raw)) {
				collected.push("");
				this.pos++;
				continue;
			}
			const indent = line.raw.length - line.raw.trimStart().length;
			if (indent <= parentIndent) break;
			if (blockIndent === -1) blockIndent = indent;
			if (indent < blockIndent) break;
			collected.push(line.raw.slice(blockIndent).trimEnd());
			this.pos++;
		}
		// Trailing blank lines belong to the chomping behavior, not content.
		while (collected.length > 0 && collected[collected.length - 1] === "")
			collected.pop();
		const joined = collected.join("\n");
		if (chomp === "strip" || joined === "") return joined;
		return joined + "\n";
	}
}

function parseScalar(text: string, line: number): YamlValue {
	if (text.startsWith("[") && text.endsWith("]")) {
		const inner = text.slice(1, -1).trim();
		if (!inner) return [];
		return splitFlowList(inner, line).map((part) =>
			parseScalar(part.trim(), line),
		);
	}
	if (text.startsWith('"')) {
		if (!text.endsWith('"') || text.length < 2)
			throw new ConfigError("unterminated string", line);
		return text
			.slice(1, -1)
			.replace(/\\n/g, "\n")
			.replace(/\\"/g, '"')
			.replace(/\\\\/g, "\\");
	}
	if (text.startsWith("'")) {
		if (!text.endsWith("'") || text.length < 2)
			throw new ConfigError("unterminated string", line);
		return text.slice(1, -1).replace(/''/g, "'");
	}
	if (text === "true") return true;
	if (text === "false") return false;
	if (text === "null" || text === "~") return null;
	if (/^-?\d+(\.\d+)?$/.test(text)) return Number(text);
	return text;
}

function splitFlowList(inner: string, line: number): string[] {
	const parts: string[] = [];
	let depth = 0;
	let quote: string | undefined;
	let start = 0;
	for (let i = 0; i < inner.length; i++) {
		const ch = inner[i] as string;
		if (quote) {
			if (ch === quote) quote = undefined;
			continue;
		}
		if (ch === '"' || ch === "'") quote = ch;
		else if (ch === "[") depth++;
		else if (ch === "]") depth--;
		else if (ch === "," && depth === 0) {
			parts.push(inner.slice(start, i));
			start = i + 1;
		}
	}
	parts.push(inner.slice(start));
	if (quote) throw new ConfigError("unterminated string in flow list", line);
	return parts;
}

/** Exported for tests. */
export function parseYamlSubset(text: string): YamlValue {
	return new Parser(rawLines(text)).parse();
}

// ─────────────────────────── schema validation ───────────────────────────

export interface WatchdogConfig {
	version: "1";
	project?: string;
	/** Enable lifecycle tracing to /tmp/pi-advisor-debug.log (same as PI_ADVISOR_DEBUG=1). */
	debug?: boolean;
	advisors: AdvisorConfig[];
}

const VALID_TOOLS = new Set(["read", "grep", "find", "ls", "bash"]);
const SLUG_RE = /^[a-z0-9-]+$/;
// Provider is up to the first slash; the model id may itself contain
// slashes (proxy catalogues like modelnexus use z-ai/glm-5.3-flash) —
// same split rule as parseModelSpec in src/pi/model-caller.ts.
const MODEL_RE = /^[^/\s]+\/[^\s]+$/;
export const PROMPT_BUDGET_CHARS = 5000;
const DEFAULT_MAX_TOKENS = 80000;

function fail(message: string): never {
	throw new ConfigError(message);
}

function asRecord(
	value: YamlValue | undefined,
	what: string,
): { [k: string]: YamlValue } {
	if (value === undefined || value === null) return {};
	if (typeof value !== "object" || Array.isArray(value))
		fail(`${what} must be a map`);
	return value as { [k: string]: YamlValue };
}

function asString(
	value: YamlValue | undefined,
	what: string,
	opts: { required?: boolean } = {},
): string | undefined {
	if (value === undefined || value === null) {
		if (opts.required) fail(`${what} is required`);
		return undefined;
	}
	if (typeof value !== "string")
		fail(`${what} must be a string, got ${JSON.stringify(value)}`);
	return value;
}

function asStringList(
	value: YamlValue | undefined,
	what: string,
): string[] | undefined {
	if (value === undefined || value === null) return undefined;
	if (!Array.isArray(value) || value.some((v) => typeof v !== "string" || !v)) {
		fail(`${what} must be a list of non-empty strings`);
	}
	return value as string[];
}

function parseTrigger(
	value: YamlValue | undefined,
	slug: string,
): TriggerConfig {
	const rec = asRecord(value, `advisors[${slug}].trigger`);
	const frequency =
		asString(rec["frequency"], `advisors[${slug}].trigger.frequency`) ??
		"per-update";
	if (frequency !== "per-update" && frequency !== "per-N-turns") {
		fail(`advisors[${slug}].trigger.frequency must be per-update | per-N-turns`);
	}
	const priority =
		asString(rec["priority"], `advisors[${slug}].trigger.priority`) ?? "normal";
	if (priority !== "low" && priority !== "normal" && priority !== "high") {
		fail(`advisors[${slug}].trigger.priority must be low | normal | high`);
	}
	const everyRaw = rec["every"];
	let every: number | undefined;
	if (everyRaw !== undefined && everyRaw !== null) {
		if (
			typeof everyRaw !== "number" ||
			!Number.isInteger(everyRaw) ||
			everyRaw < 1
		) {
			fail(`advisors[${slug}].trigger.every must be a positive integer`);
		}
		every = everyRaw;
	}
	if (frequency === "per-N-turns" && every === undefined) {
		fail(`advisors[${slug}]: frequency per-N-turns requires every: N`);
	}
	const trigger: TriggerConfig = { frequency, priority };
	if (every !== undefined) trigger.every = every;
	return trigger;
}

function parseAdvisor(
	raw: YamlValue,
	defaults: { [k: string]: YamlValue },
	index: number,
): AdvisorConfig {
	const rec = asRecord(raw, `advisors[${index}]`);
	const slug = asString(rec["slug"], `advisors[${index}].slug`, {
		required: true,
	})!;
	if (!SLUG_RE.test(slug)) fail(`advisor slug "${slug}" must match [a-z0-9-]+`);
	const name = asString(rec["name"], `advisors[${index}].name`) ?? slug;
	const model =
		asString(rec["model"], `advisors[${slug}].model`) ??
		asString(defaults["model"], "defaults.model");
	if (!model)
		fail(`advisors[${slug}].model is required (no defaults.model either)`);
	if (!MODEL_RE.test(model)) {
		fail(
			`advisors[${slug}].model "${model}" must look like provider/model-id[:thinking]`,
		);
	}
	const prompt = asString(rec["prompt"], `advisors[${slug}].prompt`, {
		required: true,
	})!;
	if (prompt.length > PROMPT_BUDGET_CHARS) {
		fail(
			`advisors[${slug}].prompt is ${prompt.length} chars — budget is ${PROMPT_BUDGET_CHARS}`,
		);
	}
	const toolsRaw = asStringList(rec["tools"], `advisors[${slug}].tools`) ?? [];
	for (const t of toolsRaw) {
		if (!VALID_TOOLS.has(t))
			fail(`advisors[${slug}].tools: "${t}" is not a read-only tool name`);
	}
	const failurePolicy =
		asString(rec["failurePolicy"], `advisors[${slug}].failurePolicy`) ??
		asString(defaults["failurePolicy"], "defaults.failurePolicy") ??
		"backoff";
	if (failurePolicy !== "halt" && failurePolicy !== "backoff") {
		fail(`advisors[${slug}].failurePolicy must be halt | backoff`);
	}
	const maxTokensRaw = rec["maxTokens"] ?? defaults["maxTokens"];
	let maxTokens = DEFAULT_MAX_TOKENS;
	if (maxTokensRaw !== undefined && maxTokensRaw !== null) {
		if (typeof maxTokensRaw !== "number" || maxTokensRaw < 1024) {
			fail(`advisors[${slug}].maxTokens must be a number >= 1024`);
		}
		maxTokens = maxTokensRaw;
	}
	const enabledRaw = rec["enabled"];
	if (enabledRaw !== undefined && typeof enabledRaw !== "boolean") {
		fail(`advisors[${slug}].enabled must be a boolean`);
	}
	const cfg: AdvisorConfig = {
		name,
		slug,
		model,
		prompt,
		tools: toolsRaw as ReadonlyToolName[],
		trigger: parseTrigger(rec["trigger"], slug),
		maxTokens,
		failurePolicy,
		enabled: enabledRaw ?? true,
	};
	const focus = asStringList(rec["focus"], `advisors[${slug}].focus`);
	if (focus) cfg.focus = focus;
	const ignore = asStringList(rec["ignore"], `advisors[${slug}].ignore`);
	if (ignore) cfg.ignore = ignore;
	return cfg;
}

export function parseConfig(
	text: string,
	source = "WATCHDOG.yml",
): WatchdogConfig {
	let raw: YamlValue;
	try {
		raw = parseYamlSubset(text);
	} catch (err) {
		if (err instanceof ConfigError)
			throw new ConfigError(`${source}: ${err.message}`, err.line);
		throw err;
	}
	const root = asRecord(raw, "root");
	const version = asString(root["version"], "version", { required: true })!;
	if (version !== "1") fail(`unsupported version "${version}" (only "1")`);
	const advisorsRaw = root["advisors"];
	if (advisorsRaw === undefined || advisorsRaw === null)
		return { version: "1", advisors: [] };
	if (!Array.isArray(advisorsRaw)) fail("advisors must be a list");
	const defaults = asRecord(root["defaults"], "defaults");
	const seen = new Set<string>();
	const advisors = advisorsRaw.map((a, i) => {
		const cfg = parseAdvisor(a, defaults, i);
		if (seen.has(cfg.slug)) fail(`duplicate advisor slug "${cfg.slug}"`);
		seen.add(cfg.slug);
		return cfg;
	});
	const config: WatchdogConfig = { version: "1", advisors };
	const project = asString(root["project"], "project");
	if (project) config.project = project;
	const debugRaw = root["debug"];
	if (debugRaw !== undefined && typeof debugRaw !== "boolean")
		fail("debug must be a boolean");
	if (debugRaw) config.debug = true;
	return config;
}

/** Load and parse one config file; undefined when the file does not exist. */
export function loadConfigFile(path: string): WatchdogConfig | undefined {
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw err;
	}
	return parseConfig(text, path);
}

/**
 * Merge global and project configs (architecture §5.1): project advisors
 * replace same-slug global advisors; the rest are appended.
 */
export function mergeConfigs(
	globalCfg: WatchdogConfig | undefined,
	projectCfg: WatchdogConfig | undefined,
): WatchdogConfig {
	if (!globalCfg) return projectCfg ?? { version: "1", advisors: [] };
	if (!projectCfg) return globalCfg;
	const bySlug = new Map<string, AdvisorConfig>();
	for (const a of globalCfg.advisors) bySlug.set(a.slug, a);
	for (const a of projectCfg.advisors) bySlug.set(a.slug, a);
	const merged: WatchdogConfig = {
		version: "1",
		advisors: [...bySlug.values()],
	};
	if (projectCfg.project ?? globalCfg.project) {
		merged.project = (projectCfg.project ?? globalCfg.project) as string;
	}
	// debug is a switch, not an override: either side opting in turns it on.
	if (globalCfg.debug || projectCfg.debug) merged.debug = true;
	return merged;
}
