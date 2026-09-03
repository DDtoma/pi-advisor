/**
 * Roster: config discovery + AdvisorRuntime lifecycle (architecture
 * §5.1). Owns the runtime instance; reload swaps it under the commands.
 *
 * Discovery (architecture §5.1): ~/.pi/agent/WATCHDOG.yml (global) then
 * <project-root>/WATCHDOG.yml (overrides same-slug advisors). Both paths
 * are passed IN — git-root detection is glue-layer work (extensions/).
 *
 * Config errors never propagate: a broken file is reported in `errors`
 * and the remaining files still load (the extension must survive a typo'd
 * project config).
 */
import { join } from "node:path";
import { loadConfigFile, mergeConfigs, type WatchdogConfig } from "./config.ts";
import {
	AdvisorRuntime,
	type AdvisorRuntimeOptions,
	type AdvisorStatus,
} from "./runtime.ts";
import type {
	DeltaSource,
	Injector,
	ModelCaller,
	UsageTotals,
} from "./types.ts";

export interface RosterDeps {
	source: DeltaSource;
	caller: ModelCaller;
	injector: Injector;
	cwd: string;
	globalConfigPath: string;
	projectRoot: string;
	sleep?: (ms: number) => Promise<void>;
	/** Trigger-activity observer, forwarded to the runtime (debug mode). */
	onEvent?: (slug: string, message: string) => void;
}

export interface LoadReport {
	advisorCount: number;
	errors: string[];
	/** Merged config `debug: true` — the glue layer uses it to enable file logging. */
	debug: boolean;
}

export class AdvisorRoster {
	#deps: RosterDeps;
	#runtime: AdvisorRuntime | undefined;
	#errors: string[] = [];

	constructor(deps: RosterDeps) {
		this.#deps = deps;
	}

	get runtime(): AdvisorRuntime | undefined {
		return this.#runtime;
	}

	/** (Re)load configs and rebuild the runtime. Previous state is discarded (ADR-005). */
	load(): LoadReport {
		this.#errors = [];
		const globalCfg = this.#loadOne(this.#deps.globalConfigPath);
		const projectCfg = this.#loadOne(
			join(this.#deps.projectRoot, "WATCHDOG.yml"),
		);
		const merged: WatchdogConfig = mergeConfigs(globalCfg, projectCfg);

		const old = this.#runtime;
		if (old) old.dispose();
		if (merged.advisors.length === 0) {
			this.#runtime = undefined;
			return {
				advisorCount: 0,
				errors: [...this.#errors],
				debug: merged.debug ?? false,
			};
		}
		const opts: AdvisorRuntimeOptions = {
			source: this.#deps.source,
			caller: this.#deps.caller,
			injector: this.#deps.injector,
			cwd: this.#deps.cwd,
		};
		if (this.#deps.sleep) opts.sleep = this.#deps.sleep;
		if (this.#deps.onEvent) opts.onEvent = this.#deps.onEvent;
		this.#runtime = new AdvisorRuntime(merged.advisors, opts);
		// Cursors start at the branch end — no history replay (ADR-005).
		this.#runtime.reset();
		return {
			advisorCount: merged.advisors.length,
			errors: [...this.#errors],
			debug: merged.debug ?? false,
		};
	}

	#loadOne(path: string): WatchdogConfig | undefined {
		try {
			return loadConfigFile(path);
		} catch (err) {
			this.#errors.push(err instanceof Error ? err.message : String(err));
			return undefined;
		}
	}

	onTurnEnd(turnIndex: number): void {
		this.#runtime?.onTurnEnd(turnIndex);
	}

	status(): AdvisorStatus[] {
		return this.#runtime?.status() ?? [];
	}

	usageTotals(): UsageTotals {
		const total: UsageTotals = { input: 0, output: 0, calls: 0 };
		for (const s of this.status()) {
			total.input += s.usage.input;
			total.output += s.usage.output;
			total.calls += s.usage.calls;
		}
		return total;
	}

	setEnabled(slug: string, enabled: boolean): boolean {
		return this.#runtime?.setEnabled(slug, enabled) ?? false;
	}

	reset(slug?: string): void {
		this.#runtime?.reset(slug);
	}

	previewNext(): {
		slug: string;
		name: string;
		wouldTrigger: boolean;
		reason: string;
	}[] {
		return this.#runtime?.previewNext() ?? [];
	}

	/** session_compact hook. */
	resetContexts(): void {
		this.#runtime?.resetContexts();
	}

	/** /advisor now. */
	forceTrigger(slug: string): string {
		return this.#runtime?.forceTrigger(slug) ?? `advisor system not loaded`;
	}

	async settle(): Promise<void> {
		await this.#runtime?.settle();
	}

	dispose(): void {
		this.#runtime?.dispose();
		this.#runtime = undefined;
	}
}
