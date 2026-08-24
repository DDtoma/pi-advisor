/**
 * Test entry point: imports every *.test.ts in this directory so
 * `node --experimental-strip-types test/run.ts` runs the whole suite
 * via node:test's auto-run on import.
 */
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const dir = dirname(fileURLToPath(import.meta.url));
const files = readdirSync(dir)
	.filter((f) => f.endsWith(".test.ts"))
	.sort();

for (const f of files) {
	await import(pathToFileURL(join(dir, f)).href);
}
