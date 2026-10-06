// Fills abi/<slug>/<version>/ from the sources pinned in abi/sources.json, then
// regenerates the derived files (index.ts, root copies) via generate-abi-ts.
//
// Usage:
//   just import-abi                    # every (slug, version) in sources.json
//   just import-abi <slug>             # every version of one component
//   just import-abi <slug> <version>   # one folder
//   just import-abi --dry-run [...]    # report only, no writes
//
// Version folders are additive (see planMerge): new contracts are added,
// identical ones are a no-op, and a different ABI for an existing contract is
// a hard error. To replace a file on purpose, delete it and re-import.

import { resolve } from "@std/path";
import { AbiSources } from "./schema.ts";
import { type AbiSet, planMerge } from "./lib/abi.ts";
import { fetchAbis } from "./lib/fetch-abi.ts";
import { generateAbiTs } from "./generate-abi-ts.ts";

const ABI_DIR = resolve(import.meta.dirname!, "..", "abi");

async function main() {
  const args = [...Deno.args];
  const dryRun = args.includes("--dry-run");
  const [slugFilter, versionFilter] = args.filter((a) => a !== "--dry-run");

  const sources = AbiSources.parse(JSON.parse(await Deno.readTextFile(resolve(ABI_DIR, "sources.json"))));
  const targets = Object.entries(sources)
    .filter(([slug]) => !slugFilter || slug === slugFilter)
    .flatMap(([slug, versions]) =>
      Object.entries(versions)
        .filter(([v]) => !versionFilter || v === versionFilter)
        .map(([version, entry]) => ({ slug, version, entry }))
    );
  if (!targets.length) {
    console.error(`nothing in abi/sources.json matches ${[slugFilter, versionFilter].filter(Boolean).join(" ") || "(empty)"}`);
    Deno.exit(2);
  }

  let failed = false;
  for (const { slug, version, entry } of targets) {
    const label = `${slug}/${version}`;
    try {
      const dir = resolve(ABI_DIR, slug, version);
      const incoming = await fetchAbis(entry);
      const plan = planMerge(await readAbiDir(dir), incoming);
      if (plan.conflicts.length) {
        throw new Error(
          `ABI differs from the one already in abi/${label} for: ${plan.conflicts.join(", ")}. ` +
            `Version folders never change an existing ABI; a new ABI means a new version folder.`,
        );
      }
      const notes = [
        plan.added.length ? `+${plan.added.length} (${plan.added.join(", ")})` : "",
        plan.unchanged.length ? `${plan.unchanged.length} unchanged` : "",
        plan.notInSource.length ? `kept, not in source: ${plan.notInSource.join(", ")}` : "",
      ].filter(Boolean).join("; ");
      if (!dryRun && plan.added.length) {
        await Deno.mkdir(dir, { recursive: true });
        for (const name of plan.added) {
          await Deno.writeTextFile(resolve(dir, `${name}.json`), JSON.stringify(incoming.get(name), null, 2) + "\n");
        }
      }
      console.log(`  ${plan.added.length ? "✓" : "·"} ${label} ← ${entry.source}: ${notes}${dryRun ? "  (dry-run)" : ""}`);
    } catch (e) {
      failed = true;
      console.error(`  ✗ ${label} ← ${entry.source}: ${e instanceof Error ? e.message : e}`);
    }
  }

  if (failed) {
    console.error("\nsome sources failed; derived files (index.ts, root copies) not regenerated");
    Deno.exit(1);
  }
  if (!dryRun) await generateAbiTs(ABI_DIR);
}

async function readAbiDir(dir: string): Promise<AbiSet> {
  const set: AbiSet = new Map();
  try {
    for await (const e of Deno.readDir(dir)) {
      if (e.isFile && e.name.endsWith(".json")) {
        set.set(e.name.slice(0, -5), JSON.parse(await Deno.readTextFile(resolve(dir, e.name))));
      }
    }
  } catch (e) {
    if (!(e instanceof Deno.errors.NotFound)) throw e;
  }
  return set;
}

await main();
