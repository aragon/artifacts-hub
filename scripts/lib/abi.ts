// Pure helpers shared by the ABI scripts (import, generate, verify). No IO here
// so every rule is unit-testable.

import { type AbiFunction, toFunctionSelector } from "viem";

export type Abi = readonly Record<string, unknown>[];
export type AbiSet = Map<string, Abi>; // contract name → ABI

const VERSION_DIR = /^v\d+(\.\d+)+$/;

export function isVersionDir(name: string): boolean {
  return VERSION_DIR.test(name);
}

// Numeric, segment-wise: v1.10 > v1.9, v1.4.0 > v1.4. Shorter prefix sorts first.
export function compareVersions(a: string, b: string): number {
  const pa = a.slice(1).split(".").map(Number);
  const pb = b.slice(1).split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? -1) - (pb[i] ?? -1);
    if (d !== 0) return d;
  }
  return 0;
}

export function latestVersion(dirs: string[]): string | undefined {
  return dirs.filter(isVersionDir).sort(compareVersions).at(-1);
}

// Two ABIs are the same when they hold the same entries, in any order. Key
// order inside an entry is normalised too: different toolchains emit the same
// item with keys in different order.
export function abiEqual(a: Abi, b: Abi): boolean {
  const norm = (abi: Abi) => abi.map((e) => canonical(e)).sort();
  const na = norm(a), nb = norm(b);
  return na.length === nb.length && na.every((x, i) => x === nb[i]);
}

function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(v);
}

export type MergePlan = { added: string[]; unchanged: string[]; conflicts: string[]; notInSource: string[] };

// Version folders are additive: new contracts land, identical ones are a no-op,
// and a different ABI for an existing contract is a conflict (the caller must
// refuse to write). `notInSource` lists files on disk the source no longer has;
// they stay, but the caller reports them.
export function planMerge(existing: AbiSet, incoming: AbiSet): MergePlan {
  const plan: MergePlan = { added: [], unchanged: [], conflicts: [], notInSource: [] };
  for (const [name, abi] of incoming) {
    const cur = existing.get(name);
    if (!cur) plan.added.push(name);
    else if (abiEqual(cur, abi)) plan.unchanged.push(name);
    else plan.conflicts.push(name);
  }
  for (const name of existing.keys()) if (!incoming.has(name)) plan.notInSource.push(name);
  for (const list of Object.values(plan)) list.sort();
  return plan;
}

// ABIs from a JS module: `<Name>ABI` array exports (the `*-artifacts`
// packages) or TypeChain `<Name>__factory` classes with a static `abi`
// (the legacy `@aragon/osx-ethers` bundles).
export function abisFromModule(mod: Record<string, unknown>): AbiSet {
  const out: AbiSet = new Map();
  for (const [key, value] of Object.entries(mod)) {
    let name: string | undefined, abi: unknown;
    if (key.endsWith("ABI") && Array.isArray(value)) {
      name = key.slice(0, -3);
      abi = value;
    } else if (key.endsWith("__factory") && value && Array.isArray((value as { abi?: unknown }).abi)) {
      name = key.slice(0, -"__factory".length);
      abi = (value as { abi: unknown[] }).abi;
    }
    if (!name || !(abi as unknown[]).length) continue;
    out.set(name, structuredClone(abi) as Abi);
  }
  return out;
}

// One forge `out/<File>.sol/<Contract>.json` artifact (built with `--ast`).
// Keeps the component's public surface: contracts, interfaces and libraries
// declared under `src/` with a non-empty ABI. Abstract contracts are skipped:
// they can't be deployed, and their functions are already in the ABI of every
// contract that extends them. Returns undefined for anything skipped.
export function abiFromForgeArtifact(artifact: unknown): { name: string; abi: Abi } | undefined {
  const a = artifact as {
    abi?: Abi;
    metadata?: { settings?: { compilationTarget?: Record<string, string> } };
    ast?: { nodes?: { nodeType?: string; name?: string; abstract?: boolean }[] };
  };
  const target = Object.entries(a.metadata?.settings?.compilationTarget ?? {})[0];
  if (!target || !a.abi?.length) return;
  const [path, name] = target;
  if (!path.startsWith("src/")) return;
  const def = a.ast?.nodes?.find((n) => n.nodeType === "ContractDefinition" && n.name === name);
  if (!def) throw new Error(`${path}:${name} has no AST (build with \`forge build --ast\`)`);
  if (def.abstract) return;
  return { name, abi: a.abi };
}

export function pickContracts(set: AbiSet, names: readonly string[] | undefined): AbiSet {
  if (!names) return set;
  const missing = names.filter((n) => !set.has(n));
  if (missing.length) throw new Error(`source has no ABI for: ${missing.join(", ")}`);
  return new Map(names.map((n) => [n, set.get(n)!]));
}

// Function selectors of `abi` that don't appear in the deployed runtime `code`.
// A plain substring search: the dispatcher embeds every external selector as a
// 4-byte constant, so an absent one means the ABI doesn't match the contract.
// (A present one can be a coincidental byte match; the check is one-sided.)
export function missingSelectors(abi: Abi, code: string): string[] {
  const hex = code.toLowerCase().replace(/^0x/, "");
  return abi
    .filter((e) => e.type === "function")
    .map((e) => ({ sig: e.name as string, sel: toFunctionSelector(e as unknown as AbiFunction).slice(2) }))
    .filter(({ sel }) => !hex.includes(sel))
    .map(({ sig, sel }) => `${sig} (0x${sel})`);
}
