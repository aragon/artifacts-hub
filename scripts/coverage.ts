// Coverage audit: walks addresses/*.json, classifies each chain, prints a
// grouped table + per-section gap summary. Read-only. Exit 0 when every
// required slot is populated everywhere; non-zero otherwise.
//
// Slot tiers:
//   - required  : must be present on every chain
//   - optional  : chain-scoped absence is fine (deployers.protocolFactory,
//                 only present on chains deployed via ProtocolFactory)
//   - chain-conditional: exists only on specific chains (e.g. memberRegistry
//                 needs the official ENS, which only mainnet has). Not a gap
//                 anywhere else: those chains skip the slot entirely.

import { resolve } from "@std/path";
import { AddressBook } from "./schema.ts";

const HERE = import.meta.dirname!;
const ADDRESSES_DIR = resolve(HERE, "..", "addresses");

type SlotSpec = {
  path: string;
  optional?: boolean;
  onlyOn?: number[];    // if set, slot only exists on these chainIds
};

const SLOT_SPECS: SlotSpec[] = [
  // OSx core
  { path: "osx.versions[0].core.daoBase" },
  { path: "osx.versions[0].core.daoFactory" },
  { path: "osx.versions[0].core.daoRegistry" },
  { path: "osx.versions[0].core.pluginRepoFactory" },
  { path: "osx.versions[0].core.pluginRepoRegistry" },
  { path: "osx.versions[0].core.pluginSetupProcessor" },
  { path: "osx.versions[0].core.memberRegistry", onlyOn: [1] },
  // OSx helpers.
  { path: "osx.versions[0].helpers.globalExecutor" },
  // Management
  { path: "management.dao" },
  { path: "management.daoMultisig" },
  // ENS — every chain the hub tracks uses Aragon's ENS stack.
  { path: "ens.registry" },
  { path: "ens.daoSubdomainRegistrar" },
  { path: "ens.pluginSubdomainRegistrar" },
  { path: "ens.publicResolver" },
  // Plugin repos + at-least-one version each.
  { path: "plugins.admin.repo" },
  { path: "plugins.admin.versions[0]" },
  { path: "plugins.multisig.repo" },
  { path: "plugins.multisig.versions[0]" },
  { path: "plugins.token-voting.repo" },
  { path: "plugins.token-voting.versions[0]" },
  { path: "plugins.spp.repo" },
  { path: "plugins.spp.versions[0]" },
  { path: "plugins.lock-to-vote.repo" },
  { path: "plugins.lock-to-vote.versions[0]" },
  // Conditions
  { path: "conditions.factories[0].address" },
  // One-shot deployers — optional (older chains predate the concept).
  { path: "deployers.protocolFactory", optional: true },
];

function getPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const seg of path.split(".")) {
    const m = seg.match(/^(.+)\[(\d+)\]$/);
    if (m) {
      cur = (cur as Record<string, unknown>)?.[m[1]];
      cur = Array.isArray(cur) ? cur[Number(m[2])] : undefined;
    } else {
      cur = (cur as Record<string, unknown>)?.[seg];
    }
    if (cur === undefined) return undefined;
  }
  return cur;
}

type PerNetwork = {
  network: string;
  chainId: number;
  status: "complete" | "ok" | "partial" | "invalid" | "deprecated";
  missing: string[];           // required slots that are missing
  missingOptional: string[];   // optional slots that are missing (real chain-scoped absences)
};

async function main() {
  const rows: PerNetwork[] = [];

  // Walk addresses/*.json (skipping symlinks).
  const seen = new Set<string>();
  for await (const entry of Deno.readDir(ADDRESSES_DIR)) {
    if (!entry.isFile || !entry.name.endsWith(".json")) continue;
    const path = resolve(ADDRESSES_DIR, entry.name);
    const real = await Deno.realPath(path);
    if (seen.has(real)) continue;
    seen.add(real);

    let raw: unknown;
    try {
      raw = JSON.parse(await Deno.readTextFile(real));
    } catch {
      continue;
    }
    const parsed = AddressBook.safeParse(raw);
    if (!parsed.success) {
      rows.push({
        network: entry.name,
        chainId: Number(entry.name.replace(/\.json$/, "")) || 0,
        status: "invalid",
        missing: [],
        missingOptional: [],
      });
      continue;
    }

    const book = parsed.data;
    const missing: string[] = [];
    const missingOptional: string[] = [];
    for (const spec of SLOT_SPECS) {
      if (spec.onlyOn && !spec.onlyOn.includes(book.chainId)) continue;
      const v = getPath(book, spec.path);
      if (v !== undefined) continue;
      // Deprecated chains: never required, so missing slots just go to the
      // optional bucket and never fail the gate.
      const required = !book.deprecated && !spec.optional;
      (required ? missing : missingOptional).push(spec.path);
    }
    const status: PerNetwork["status"] = book.deprecated
      ? "deprecated"
      : missing.length > 0 ? "partial"
      : missingOptional.length > 0 ? "ok" : "complete";
    rows.push({ network: book.network, chainId: book.chainId, status, missing, missingOptional });
  }

  rows.sort((a, b) => a.network.localeCompare(b.network));

  if (Deno.args.includes("--json")) {
    console.log(JSON.stringify(rows, null, 2));
    Deno.exit(rows.some(r => r.status === "partial" || r.status === "invalid") ? 1 : 0);
  }

  // --- grouped console.table view ---
  const STATUS_ORDER: PerNetwork["status"][] = ["complete", "ok", "deprecated", "partial", "invalid"];
  const STATUS_LABEL: Record<PerNetwork["status"], string> = {
    complete: "✓ COMPLETE — every slot present",
    ok: "◐ OK — required present, optional gaps are chain-scoped",
    deprecated: "⌀ DEPRECATED — chain retired; gaps not enforced",
    partial: "⚠ PARTIAL — required slots missing",
    invalid: "✗ INVALID — file fails schema",
  };

  for (const status of STATUS_ORDER) {
    const chunk = rows.filter(r => r.status === status);
    if (!chunk.length) continue;
    console.log(`\n${STATUS_LABEL[status]}  (${chunk.length})`);
    console.table(chunk.map(r => ({
      network: r.network,
      chainId: r.chainId,
      "req missing": r.missing.length,
      "opt missing": r.missingOptional.length,
      required: r.missing.map(shorten).join(", ") || "-",
    })));
  }

  const totals = STATUS_ORDER
    .map(s => `${rows.filter(r => r.status === s).length} ${s}`)
    .join(", ");
  console.log(`\n${rows.length} networks: ${totals}`);

  // --- per-section gap summary ---
  type SlotGap = { slot: string; count: number; optional: boolean };
  const bySection = new Map<string, SlotGap[]>();
  for (const spec of SLOT_SPECS) {
    const count = rows.filter(r =>
      (spec.optional ? r.missingOptional : r.missing).includes(spec.path)
    ).length;
    if (!count) continue;
    const section = spec.path.split(/\.|\[/)[0];
    const arr = bySection.get(section) ?? [];
    arr.push({ slot: shorten(spec.path), count, optional: !!spec.optional });
    bySection.set(section, arr);
  }
  if (bySection.size) {
    console.log("\nSLOTS MISSING — grouped by section:");
    for (const [section, gaps] of bySection) {
      const req = gaps.filter(g => !g.optional);
      const opt = gaps.filter(g => g.optional);
      const parts: string[] = [];
      if (req.length) parts.push(req.map(g => `${g.slot}[${g.count}]`).join(", "));
      if (opt.length) parts.push(`opt: ${opt.map(g => `${g.slot}[${g.count}]`).join(", ")}`);
      console.log(`  ${section.padEnd(11)}  ${parts.join("  |  ")}`);
    }
  }

  // --- --gaps flag: slot-centric inverted view ---
  if (Deno.args.includes("--gaps")) {
    console.log("");
    type Gap = { slot: string; missingOn: string[]; optional: boolean };
    const gaps: Gap[] = [];
    for (const spec of SLOT_SPECS) {
      const missingOn = rows
        .filter(r => (spec.optional ? r.missingOptional : r.missing).includes(spec.path))
        .map(r => r.network);
      if (missingOn.length) gaps.push({ slot: spec.path, missingOn, optional: !!spec.optional });
    }
    gaps.sort((a, b) => b.missingOn.length - a.missingOn.length);
    const required = gaps.filter(g => !g.optional);
    const optional = gaps.filter(g => g.optional);
    const sep = "─".repeat(80);
    if (required.length) {
      console.log(sep);
      console.log("REQUIRED slots missing on at least one chain:");
      console.log(sep);
      for (const g of required) {
        console.log(`  ${g.slot}`);
        console.log(`    missing on (${g.missingOn.length}): ${g.missingOn.join(", ")}`);
      }
    } else {
      console.log("All required slots populated everywhere.");
    }
    if (optional.length) {
      console.log("");
      console.log(sep);
      console.log("OPTIONAL slots missing (usually fine — chain-scoped absence):");
      console.log(sep);
      for (const g of optional) {
        console.log(`  ${g.slot}`);
        console.log(`    missing on (${g.missingOn.length}): ${g.missingOn.join(", ")}`);
      }
    }
  }

  Deno.exit(rows.some(r => r.status === "partial" || r.status === "invalid") ? 1 : 0);
}

function shorten(path: string): string {
  return path.replace(/^osx\.versions\[0\]\./, "osx.").replace(/^plugins\./, "");
}

await main();
