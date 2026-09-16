// Merge multiple partial AddressBook fragments (keyed by chainId) into one
// AddressBook per chainId. Later fragments beat earlier ones only when they
// provide a value: undefined never overwrites a previous value. Order the
// input to reflect authority: ProtocolFactory snapshot first (whole-chain,
// authoritative), then flat maps, then per-deploy overlays.

import type { Partial } from "./sources.ts";
import type { AddressBook } from "../schema.ts";

type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };
type PartialFragment = DeepPartial<AddressBook>;

// Recursive merge: takes the "more populated" side per leaf. Arrays are
// replaced whole (osx.versions[] currently only ever has one entry from the
// upstream sources, so no array merging is needed).
function mergeDeep<T extends Record<string, unknown>>(base: T, overlay: T): T {
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(overlay)) {
    if (v === undefined || v === null) continue;
    const b = out[k];
    if (
      typeof v === "object" && !Array.isArray(v) &&
      typeof b === "object" && b !== null && !Array.isArray(b)
    ) {
      out[k] = mergeDeep(b as Record<string, unknown>, v as Record<string, unknown>);
    } else {
      out[k] = v;
    }
  }
  return out as T;
}

export function mergeByChain(partials: Partial[]): Map<number, PartialFragment> {
  const byChain = new Map<number, PartialFragment>();
  for (const p of partials) {
    const prev = byChain.get(p.chainId) ?? ({} as PartialFragment);
    byChain.set(p.chainId, mergeDeep(prev as Record<string, unknown>, p.fragment as Record<string, unknown>) as PartialFragment);
  }
  return byChain;
}
