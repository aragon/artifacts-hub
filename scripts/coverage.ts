// Audit: for every just-foundry network, does addresses/<chainId>.json exist,
// and if so which slots are populated vs missing. Two views:
//   • per-network table (what's missing where)
//   • per-slot summary (what's systemically missing, across chains)
//
// Read-only; suitable to gate CI. Pass --json for machine-readable output.
// Exit code is 0 when every network has a fully populated file, else 1.
//
// "Fully populated" is defined per slot below (SLOT_SPECS).

import { resolve } from "@std/path";
import { readAllNetworkEnvs } from "./lib/networks.ts";
import { AddressBook } from "./schema.ts";

const HERE = import.meta.dirname!;
const ADDRESSES_DIR = resolve(HERE, "..", "addresses");

// Every slot we consider load-bearing for a "fully-populated" chain. Fields
// marked "*" are chain-optional (memberRegistry only on mainnet, etc.);
// coverage reports them as missing but they don't fail the "full" gate. Keep
// this list short: schema-wide catch-alls miss the point.
type SlotSpec = { path: string; optional?: boolean };
const SLOT_SPECS: SlotSpec[] = [
  { path: "osx.versions[0].core.daoFactory" },
  { path: "osx.versions[0].core.daoRegistry" },
  { path: "osx.versions[0].core.pluginRepoFactory" },
  { path: "osx.versions[0].core.pluginRepoRegistry" },
  { path: "osx.versions[0].core.pluginSetupProcessor" },
  { path: "osx.versions[0].core.daoBase" },
  { path: "osx.versions[0].core.memberRegistry", optional: true },
  { path: "osx.versions[0].helpers.globalExecutor" },
  { path: "osx.versions[0].helpers.placeholderSetup", optional: true },
  { path: "management.dao" },
  { path: "management.daoMultisig" },
  { path: "ens.registry", optional: true },
  { path: "ens.daoSubdomainRegistrar", optional: true },
  { path: "ens.pluginSubdomainRegistrar", optional: true },
  { path: "ens.publicResolver", optional: true },
  { path: "deployers.protocolFactory", optional: true },
  { path: "plugins.admin.repo" },
  { path: "plugins.multisig.repo" },
  { path: "plugins.token-voting.repo" },
  { path: "plugins.spp.repo" },
  { path: "plugins.lock-to-vote.repo" },
  { path: "conditions.factories[0].address", optional: true },
];

// Read the value at a dotted path (with [0] indexing). Returns undefined when
// any segment is missing.
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
  // complete = every slot present (required + optional)
  // ok       = required present, some optional missing (real absences on this chain)
  // partial  = required missing (data hole)
  // invalid  = file exists but fails schema
  // missing  = no file
  status: "missing-file" | "complete" | "ok" | "partial" | "invalid";
  missing: string[];           // required slots that are missing
  missingOptional: string[];   // optional slots that are missing
};

async function main() {
  const nets = await readAllNetworkEnvs();
  const rows: PerNetwork[] = [];

  for (const n of nets) {
    const path = resolve(ADDRESSES_DIR, `${n.chainId}.json`);
    let raw: unknown;
    try {
      raw = JSON.parse(await Deno.readTextFile(path));
    } catch {
      rows.push({ network: n.network, chainId: n.chainId, status: "missing-file", missing: [], missingOptional: [] });
      continue;
    }
    const parsed = AddressBook.safeParse(raw);
    if (!parsed.success) {
      rows.push({ network: n.network, chainId: n.chainId, status: "invalid", missing: [], missingOptional: [] });
      continue;
    }
    const missing: string[] = [];
    const missingOptional: string[] = [];
    for (const spec of SLOT_SPECS) {
      const v = getPath(parsed.data, spec.path);
      if (v !== undefined) continue;
      (spec.optional ? missingOptional : missing).push(spec.path);
    }
    let status: PerNetwork["status"];
    if (missing.length > 0) status = "partial";
    else if (missingOptional.length > 0) status = "ok";
    else status = "complete";
    rows.push({ network: n.network, chainId: n.chainId, status, missing, missingOptional });
  }

  if (Deno.args.includes("--json")) {
    console.log(JSON.stringify(rows, null, 2));
    // Only fail on real data holes; optional-only gaps are "ok".
    Deno.exit(rows.some(r => r.status === "partial" || r.status === "invalid" || r.status === "missing-file") ? 1 : 0);
  }

  if (Deno.args.includes("--gaps")) {
    // Slot-centric view: which chains are missing each slot. Required and
    // optional slots split so you can eyeball what's a real problem vs
    // what's an accepted "not deployed here" gap.
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
      console.log("OPTIONAL slots missing (usually fine: chain-scoped absence):");
      console.log(sep);
      for (const g of optional) {
        console.log(`  ${g.slot}`);
        console.log(`    missing on (${g.missingOn.length}): ${g.missingOn.join(", ")}`);
      }
    }
    Deno.exit(required.length ? 1 : 0);
  }

  // Group networks by status → one console.table per group. Empty groups are
  // skipped so the output stays tight (no "complete: 0" table when nothing
  // qualifies).
  const STATUS_ORDER: PerNetwork["status"][] = [
    "complete", "ok", "partial", "invalid", "missing-file",
  ];
  const STATUS_LABEL: Record<PerNetwork["status"], string> = {
    complete: "✓ COMPLETE: every slot present",
    ok: "◐ OK: required present, optional gaps are chain-scoped",
    partial: "⚠ PARTIAL: required slots missing",
    invalid: "✗ INVALID: file fails schema",
    "missing-file": "· MISSING: no addresses file",
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

  // Totals line
  const totals = STATUS_ORDER
    .map(s => `${rows.filter(r => r.status === s).length} ${s}`)
    .join(", ");
  console.log(`\n${rows.length} networks: ${totals}`);

  // Per-slot summary, grouped by top-level section so gaps that go together
  // (e.g. all four ENS fields missing on the same 12 chains) surface as one
  // domain problem instead of four bullet points.
  type SlotGap = { slot: string; count: number; optional: boolean };
  const bySection = new Map<string, SlotGap[]>();
  for (const spec of SLOT_SPECS) {
    const count = rows.filter(r =>
      (spec.optional ? r.missingOptional : r.missing).includes(spec.path),
    ).length;
    if (!count) continue;
    const section = spec.path.split(/\.|\[/)[0]; // "osx", "plugins", "ens", …
    const arr = bySection.get(section) ?? [];
    arr.push({ slot: shorten(spec.path), count, optional: !!spec.optional });
    bySection.set(section, arr);
  }

  if (bySection.size) {
    console.log("\nSLOTS MISSING: grouped by section:");
    for (const [section, gaps] of bySection) {
      const req = gaps.filter(g => !g.optional);
      const opt = gaps.filter(g => g.optional);
      const parts: string[] = [];
      if (req.length) parts.push(req.map(g => `${g.slot}[${g.count}]`).join(", "));
      if (opt.length) parts.push(`opt: ${opt.map(g => `${g.slot}[${g.count}]`).join(", ")}`);
      console.log(`  ${section.padEnd(11)}  ${parts.join("  |  ")}`);
    }
  }

  Deno.exit(rows.some(r => r.status !== "full") ? 1 : 0);
}

// Compact display: strip "osx.versions[0]." and similar prefixes so the table
// stays legible. Reader can still expand if needed.
function shorten(path: string): string {
  return path.replace(/^osx\.versions\[0\]\./, "osx.").replace(/^plugins\./, "");
}

await main();
