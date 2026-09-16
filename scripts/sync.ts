// One-off ingest orchestrator:
//   1. enumerate networks from just-foundry/networks/*.env
//   2. pull partial AddressBook fragments from every upstream source
//   3. merge per chainId (PF snapshot has authority; flat maps fill gaps;
//      per-deploy overlays add ENS/maintainer/setup where present)
//   4. on-chain enrich for versions + protocolVersion
//   5. Zod-validate + write addresses/<chainId>.json
//   6. create <network>.json symlink
//
// Cheap and disposable: every source parser lives in lib/sources.ts and is
// tiny. If you want to re-ingest a single chain, run with `--only <chainId>`.

import { resolve } from "@std/path";
import { AddressBook } from "./schema.ts";
import { readAllNetworkEnvs, type NetworkEnv } from "./lib/networks.ts";
import { mergeByChain } from "./lib/merge.ts";
import { enrichOnChain } from "./lib/enrich.ts";
import {
  fromConditionLibrary,
  fromFlatPluginRepos,
  fromOsx,
  fromPerDeployOverlays,
  fromProtocolFactory,
  reportUnknownSlugs,
} from "./lib/sources.ts";

const HERE = import.meta.dirname!;
const ADDRESSES_DIR = resolve(HERE, "..", "addresses");

const args = new Set(Deno.args);
const onlyIdx = Deno.args.indexOf("--only");
const only = onlyIdx >= 0 ? Number(Deno.args[onlyIdx + 1]) : undefined;
const skipEnrich = args.has("--no-enrich");

async function main() {
  console.error("=== networks from just-foundry ===");
  const nets: NetworkEnv[] = await readAllNetworkEnvs();
  for (const n of nets) console.error(`  ${n.network} (${n.chainId})`);

  console.error("\n=== reading upstream sources ===");
  await reportUnknownSlugs();
  // Order matters: PF is authoritative snapshot, then OSx fills any missing
  // OSx-side fields, then flat plugin maps, then per-deploy overlays (which
  // carry ENS names + maintainer + latest setup info), finally condition
  // library. `mergeByChain` never overwrites a defined value with undefined,
  // so overlay ordering only matters when two sources both specify the same
  // field. Later wins by design → per-deploy details beat the flat-map repo,
  // which beats what PF put there. Fine because those are all the SAME repo
  // for a given chain.
  const partials = [
    ...await fromProtocolFactory(),
    ...await fromOsx(),
    ...await fromFlatPluginRepos(),
    ...await fromPerDeployOverlays(),
    ...await fromConditionLibrary(),
  ];
  console.error(`  ${partials.length} partial fragments gathered`);

  const merged = mergeByChain(partials);
  console.error(`  ${merged.size} distinct chainIds merged`);

  console.error("\n=== writing per just-foundry network ===");
  let wrote = 0, skipped = 0, failed = 0;
  for (const n of nets) {
    if (only && n.chainId !== only) continue;

    const frag = merged.get(n.chainId);
    if (!frag) {
      console.error(`  · ${n.network} (${n.chainId}): no source data: writing seed`);
    }

    // Seed with chainId + network from just-foundry (source of truth for these).
    const book: Record<string, unknown> = {
      chainId: n.chainId,
      network: n.network,
      ...(frag ?? {}),
    };
    book.chainId = n.chainId;
    book.network = n.network;

    if (!skipEnrich) {
      try {
        console.error(`  · ${n.network} (${n.chainId}): enriching via ${n.rpc}`);
        await enrichOnChain(book as never, n.rpc);
      } catch (e) {
        console.error(`    enrich failed: ${(e as Error).message}`);
      }
    }

    const parsed = AddressBook.safeParse(book);
    if (!parsed.success) {
      failed++;
      console.error(`  ✗ ${n.network} (${n.chainId}): schema validation failed`);
      for (const issue of parsed.error.issues) {
        console.error(`      ${issue.path.join(".") || "(root)"}: ${issue.message}`);
      }
      continue;
    }
    const outPath = resolve(ADDRESSES_DIR, `${n.chainId}.json`);
    await Deno.writeTextFile(outPath, JSON.stringify(parsed.data, null, 2) + "\n");

    // symlink <network>.json → <chainId>.json (idempotent)
    const linkPath = resolve(ADDRESSES_DIR, `${n.network}.json`);
    try { await Deno.remove(linkPath); } catch { /* ok */ }
    await Deno.symlink(`${n.chainId}.json`, linkPath);

    wrote++;
    console.error(`  ✓ ${n.network} (${n.chainId}) → ${n.chainId}.json (+ ${n.network}.json symlink)`);
  }

  console.error(`\n${wrote} written, ${skipped} skipped, ${failed} failed`);
  Deno.exit(failed === 0 ? 0 : 1);
}

await main();
