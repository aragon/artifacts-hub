// Checks that every plugin version in the address book matches its versioned
// ABI: each function selector of `abi/<slug>/v<release>.<build>/<Setup>.json`
// must appear in the setup's deployed code, and likewise for the plugin
// implementation. Catches a wrong entry in abi/sources.json (an ABI from the
// wrong version) and a missing version folder.
//
// Usage:
//   just verify-abi              # every non-deprecated chain
//   just verify-abi <network>    # one chain (e.g. mainnet)
//
// Builds flagged `placeholder: true` in the book are reported and skipped.
// Builds without an implementation (zkSync Admin) only get their setup
// checked. On zkSync chains the `<Name>ZkSync` ABI is used when the version
// folder has one.
// RPC URLs come from aragon/just-foundry (see lib/networks.ts).

import { resolve } from "@std/path";
import { createPublicClient, http, type Address } from "viem";
import { AddressBook } from "./schema.ts";
import { type Abi, missingSelectors } from "./lib/abi.ts";
import { PLUGIN_CATALOG } from "./lib/plugin-catalog.ts";
import { loadNetworks, type Network } from "./lib/networks.ts";

const ROOT = resolve(import.meta.dirname!, "..");

type ChainReport = { label: string; checked: number; placeholders: string[]; problems: string[] };

async function main() {
  const [networkFilter] = Deno.args;
  const books: AddressBook[] = [];
  for await (const e of Deno.readDir(resolve(ROOT, "addresses"))) {
    if (!e.isFile || !/^\d+\.json$/.test(e.name)) continue; // chainId files; skip network symlinks
    const book = AddressBook.parse(JSON.parse(await Deno.readTextFile(resolve(ROOT, "addresses", e.name))));
    if (!networkFilter || book.network === networkFilter) books.push(book);
  }
  if (!books.length) {
    console.error(`no addresses/*.json with network "${networkFilter}"`);
    Deno.exit(2);
  }
  books.sort((a, b) => a.network.localeCompare(b.network));

  const networks = await loadNetworks();
  const reports = await Promise.all(books.map((b) => verifyChain(b, networks.get(b.network))));

  let failed = false;
  for (const r of reports) {
    failed ||= r.problems.length > 0;
    const placeholders = r.placeholders.length ? `, placeholder: ${r.placeholders.join(" ")}` : "";
    console.log(`  ${r.problems.length ? "✗" : r.checked ? "✓" : "·"} ${r.label}: ${r.checked} checked${placeholders}`);
    for (const p of r.problems) console.log(`      ${p}`);
  }
  if (failed) Deno.exit(1);
}

async function verifyChain(book: AddressBook, network: Network | undefined): Promise<ChainReport> {
  const report: ChainReport = { label: `${book.network} (${book.chainId})`, checked: 0, placeholders: [], problems: [] };
  if (book.deprecated) {
    report.label += " deprecated, skipped";
    return report;
  }
  if (!network) return fail(report, `no networks/${book.network}.env in just-foundry`);
  if (network.chainId !== book.chainId) {
    return fail(report, `just-foundry ${book.network}.env has CHAIN_ID ${network.chainId}`);
  }

  const client = createPublicClient({ transport: http(network.rpcUrl, { retryCount: 3 }) });
  const codes = new Map<string, Promise<string>>(); // same contract shows up in several builds
  const codeOf = (a: string) => {
    if (!codes.has(a)) codes.set(a, client.getCode({ address: a as Address }).then((c) => c ?? "0x"));
    return codes.get(a)!;
  };
  const zk = book.network.startsWith("zksync");

  for (const [slug, plugin] of Object.entries(book.plugins)) {
    const names = PLUGIN_CATALOG[slug]?.abi;
    if (!names) {
      report.problems.push(`${slug}: not in lib/plugin-catalog.ts`);
      continue;
    }
    for (const v of plugin.versions) {
      const version = `v${v.release}.${v.build}`;
      if (v.placeholder) {
        report.placeholders.push(`${slug}@${version}`);
        continue;
      }
      const targets = [{ role: "setup", address: v.setup, abi: names.setup }];
      if (v.implementation) targets.push({ role: "implementation", address: v.implementation, abi: names.implementation });
      for (const t of targets) {
        const where = `${slug}@${version} ${t.role} ${t.address}`;
        const abiName = zk && (await readAbi(`abi/${slug}/${version}/${t.abi}ZkSync.json`)) ? `${t.abi}ZkSync` : t.abi;
        const abi = await readAbi(`abi/${slug}/${version}/${abiName}.json`);
        if (!abi) {
          report.problems.push(`${where}: no abi/${slug}/${version}/${t.abi}.json`);
          continue;
        }
        try {
          const code = await codeOf(t.address);
          if (code === "0x") {
            report.problems.push(`${where}: no code on chain`);
            continue;
          }
          const missing = missingSelectors(abi, code);
          if (missing.length) report.problems.push(`${where}: ${abiName} functions absent: ${missing.join(", ")}`);
          report.checked++;
        } catch (e) {
          report.problems.push(`${where}: RPC error: ${e instanceof Error ? e.message.split("\n")[0] : e}`);
        }
      }
    }
  }
  return report;
}

function fail(report: ChainReport, problem: string): ChainReport {
  report.problems.push(problem);
  return report;
}

async function readAbi(path: string): Promise<Abi | undefined> {
  try {
    return JSON.parse(await Deno.readTextFile(resolve(ROOT, path)));
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return undefined;
    throw e;
  }
}

if (import.meta.main) await main();
