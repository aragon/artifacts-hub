// One-off ingest: read each upstream component's address JSON and yield partial
// AddressBook fragments keyed by chainId. Every reader is intentionally small —
// this is disposable code, run once, then only refreshed when upstream changes.
//
// Shapes handled:
//   1. protocol-factory/artifacts/addresses-<slug>-<ts>.json (whole-chain snapshot)
//   2. osx/npm-artifacts/src/addresses.json                  (transposed matrix)
//   3. */npm-artifacts/src/addresses.json                    (flat pluginRepo map)
//   4. */packages/artifacts/src/addresses.json               (same flat shape, older packages)
//   5. */artifacts/deployment-<slug>-<ts>.json               (latest per-slug overlay)

import { resolve } from "@std/path";
import { walk } from "@std/fs";
import { slugToChainId, classifySlug } from "./network-map.ts";

export type Partial = {
  chainId: number;
  fragment: DeepPartial<import("../schema.ts").AddressBook>;
};

// A tiny local "deep partial" so we can build up fragments without fighting Zod.
type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };

const REPO_ROOT = resolve(import.meta.dirname!, "..", "..", "..");

// ─── helpers ────────────────────────────────────────────────────────────────

async function readJson<T = unknown>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await Deno.readTextFile(path)) as T;
  } catch {
    return null;
  }
}

// Latest file matching `<prefix><slug>-<timestamp>.<ext>` per slug.
// Upstream doesn't clean up old ones; we always take the highest timestamp.
async function latestPerSlug(
  dir: string,
  pattern: RegExp,
): Promise<Map<string, string>> {
  const winners = new Map<string, { ts: number; path: string }>();
  try {
    for await (const entry of Deno.readDir(dir)) {
      if (!entry.isFile) continue;
      const m = entry.name.match(pattern);
      if (!m) continue;
      const slug = m[1];
      const ts = Number(m[2]);
      const prev = winners.get(slug);
      if (!prev || ts > prev.ts) {
        winners.set(slug, { ts, path: resolve(dir, entry.name) });
      }
    }
  } catch { /* directory missing → no results */ }
  return new Map(Array.from(winners, ([k, v]) => [k, v.path]));
}

// Discover every artifacts-style folder under REPO_ROOT (excluding node_modules,
// lib, out, dist, .git). Returns absolute paths to directories containing at
// least one JSON we might care about. Used only for logging what we saw.
export async function discoverArtifactFolders(): Promise<string[]> {
  const out: string[] = [];
  for await (const entry of walk(REPO_ROOT, {
    maxDepth: 4,
    includeFiles: false,
    skip: [/node_modules/, /\/lib\//, /\/out\//, /\/dist\//, /\.git/],
  })) {
    if (
      entry.name === "artifacts" ||
      entry.name === "npm-artifacts" ||
      entry.path.endsWith("/packages/artifacts")
    ) out.push(entry.path);
  }
  return out;
}

// ─── source 1: protocol-factory (full snapshot) ─────────────────────────────

type PfArtifact = {
  corePlugins?: Record<string, string>;
  ens?: Record<string, string>;
  osx?: Record<string, string>;
  protocolFactory?: string;
  conditionFactory?: string;
};

export async function fromProtocolFactory(): Promise<Partial[]> {
  const dir = resolve(REPO_ROOT, "protocol-factory", "artifacts");
  const files = await latestPerSlug(dir, /^addresses-(.+)-(\d+)\.json$/);
  const partials: Partial[] = [];
  for (const [slug, path] of files) {
    const chainId = slugToChainId(slug);
    if (!chainId) continue; // testnet or unknown, filtered here
    const j = await readJson<PfArtifact>(path);
    if (!j) continue;

    const osx = j.osx ?? {};
    const ens = j.ens ?? {};
    const cp = j.corePlugins ?? {};

    partials.push({
      chainId,
      fragment: {
        chainId,
        osx: {
          versions: [{
            protocolVersion: "unknown", // enrich step fills this from on-chain
            core: {
              daoFactory: osx.daoFactory,
              daoRegistry: osx.daoRegistry,
              pluginRepoFactory: osx.pluginRepoFactory,
              pluginRepoRegistry: osx.pluginRepoRegistry,
              pluginSetupProcessor: osx.pluginSetupProcessor,
            },
            helpers: {
              globalExecutor: osx.globalExecutor,
              placeholderSetup: osx.placeholderSetup,
            },
          }],
        },
        management: {
          dao: osx.managementDao,
          daoMultisig: osx.managementDaoMultisig,
        },
        ens: {
          registry: ens.ensRegistry,
          daoSubdomainRegistrar: ens.daoSubdomainRegistrar,
          pluginSubdomainRegistrar: ens.pluginSubdomainRegistrar,
          publicResolver: ens.publicResolver,
        },
        plugins: {
          admin: cp.adminPluginRepo ? { repo: cp.adminPluginRepo } : undefined,
          multisig: cp.multisigPluginRepo ? { repo: cp.multisigPluginRepo } : undefined,
          "token-voting": cp.tokenVotingPluginRepo ? { repo: cp.tokenVotingPluginRepo } : undefined,
          spp: cp.stagedProposalProcessorPluginRepo ? { repo: cp.stagedProposalProcessorPluginRepo } : undefined,
          "lock-to-vote": cp.lockToVotePluginRepo ? { repo: cp.lockToVotePluginRepo } : undefined,
        },
        // Some PF snapshots (robinhood onward) include a top-level
        // conditionFactory address alongside the corePlugins.
        ...(j.conditionFactory
          ? { conditions: { factories: [{ address: j.conditionFactory }] } }
          : {}),
        deployers: { protocolFactory: j.protocolFactory },
      } as Partial["fragment"],
    });
  }
  return partials;
}

// ─── source 2: osx/npm-artifacts (transposed matrix) ────────────────────────

// Explicit map of top-level keys → schema slots. Missing keys are ignored (not
// dropped silently, if OSx adds a new key, `sync` will log it as unmapped).
const OSX_KEY_MAP: Record<
  string,
  { path: "core" | "helpers" | "management"; field: string }
> = {
  dao: { path: "core", field: "daoBase" },
  daoFactory: { path: "core", field: "daoFactory" },
  daoRegistry: { path: "core", field: "daoRegistry" },
  memberRegistry: { path: "core", field: "memberRegistry" },
  pluginRepoFactory: { path: "core", field: "pluginRepoFactory" },
  pluginRepoRegistry: { path: "core", field: "pluginRepoRegistry" },
  pluginSetupProcessor: { path: "core", field: "pluginSetupProcessor" },
  executor: { path: "helpers", field: "globalExecutor" },
  managementDao: { path: "management", field: "dao" },
  managementDaoMultisig: { path: "management", field: "daoMultisig" },
};

const ZERO = "0x0000000000000000000000000000000000000000";

export async function fromOsx(): Promise<Partial[]> {
  const path = resolve(REPO_ROOT, "osx", "npm-artifacts", "src", "addresses.json");
  const j = await readJson<Record<string, Record<string, string>>>(path);
  if (!j) return [];

  // Bucket by chainId first.
  const byChain = new Map<number, Partial["fragment"]>();
  const unmappedKeys = new Set<string>();

  for (const [contract, byNetwork] of Object.entries(j)) {
    const map = OSX_KEY_MAP[contract];
    if (!map) { unmappedKeys.add(contract); continue; }

    for (const [slug, addr] of Object.entries(byNetwork)) {
      if (!addr || addr.toLowerCase() === ZERO) continue;
      const chainId = slugToChainId(slug);
      if (!chainId) continue;

      let frag = byChain.get(chainId);
      if (!frag) {
        frag = {
          chainId,
          osx: { versions: [{ protocolVersion: "unknown", core: {}, helpers: {} }] },
          management: {},
        };
        byChain.set(chainId, frag);
      }
      const v0 = frag.osx!.versions![0]!;
      if (map.path === "core") {
        (v0.core as Record<string, string>)[map.field] = addr;
      } else if (map.path === "helpers") {
        (v0.helpers as Record<string, string>)[map.field] = addr;
      } else {
        (frag.management as Record<string, string>)[map.field] = addr;
      }
    }
  }

  if (unmappedKeys.size) {
    console.error(`  [osx] unmapped top-level keys: ${[...unmappedKeys].join(", ")}`);
  }

  return Array.from(byChain, ([chainId, fragment]) => ({ chainId, fragment }));
}

// ─── source 3: flat plugin-repo maps ────────────────────────────────────────

// Component slug ↔ its addresses.json path ↔ AddressBook slot.
type FlatPluginSource = {
  component: string;                                   // for logs
  paths: string[];                                     // try in order
  topKey: string;                                      // "pluginRepo"
  slot: keyof NonNullable<Partial["fragment"]["plugins"]>; // "admin", …
};

const FLAT_PLUGIN_SOURCES: FlatPluginSource[] = [
  {
    component: "admin-plugin",
    paths: ["admin-plugin/packages/artifacts/src/addresses.json"],
    topKey: "pluginRepo",
    slot: "admin",
  },
  {
    component: "multisig-plugin",
    paths: ["multisig-plugin/packages/artifacts/src/addresses.json"],
    topKey: "pluginRepo",
    slot: "multisig",
  },
  {
    component: "token-voting-plugin",
    paths: ["token-voting-plugin/npm-artifacts/src/addresses.json"],
    topKey: "pluginRepo",
    slot: "token-voting",
  },
  {
    component: "lock-to-vote-plugin",
    paths: ["lock-to-vote-plugin/npm-artifacts/src/addresses.json"],
    topKey: "pluginRepo",
    slot: "lock-to-vote",
  },
  {
    component: "staged-proposal-processor-plugin",
    paths: ["staged-proposal-processor-plugin/npm-artifacts/src/addresses.json"],
    topKey: "pluginRepo",
    slot: "spp",
  },
];

export async function fromFlatPluginRepos(): Promise<Partial[]> {
  const out: Partial[] = [];
  for (const src of FLAT_PLUGIN_SOURCES) {
    for (const rel of src.paths) {
      const j = await readJson<Record<string, Record<string, string>>>(
        resolve(REPO_ROOT, rel),
      );
      if (!j) continue;
      const flat = j[src.topKey];
      if (!flat) continue;

      for (const [slug, addr] of Object.entries(flat)) {
        if (!addr || addr.toLowerCase() === ZERO) continue;
        const chainId = slugToChainId(slug);
        if (!chainId) continue;
        out.push({
          chainId,
          fragment: {
            chainId,
            plugins: { [src.slot]: { repo: addr } } as Partial["fragment"]["plugins"],
          },
        });
      }
    }
  }
  return out;
}

// ─── source 4: condition-library (conditions.factories[]) ─────────────────

export async function fromConditionLibrary(): Promise<Partial[]> {
  const path = resolve(REPO_ROOT, "condition-library", "npm-artifacts", "src", "addresses.json");
  const j = await readJson<Record<string, Record<string, string>>>(path);
  if (!j?.conditionFactory) return [];
  const out: Partial[] = [];
  for (const [slug, addr] of Object.entries(j.conditionFactory)) {
    if (!addr || addr.toLowerCase() === ZERO) continue;
    const chainId = slugToChainId(slug);
    if (!chainId) continue;
    // Upstream carries one address per chain today; enrich stamps current:true.
    out.push({
      chainId,
      fragment: {
        chainId,
        conditions: { factories: [{ address: addr }] },
      } as Partial["fragment"],
    });
  }
  return out;
}

// ─── source 5: per-deploy overlays (richer per plugin) ──────────────────────

type PluginDeployConfig = {
  component: string;         // subdir
  slot: string;              // AddressBook.plugins key
  repoField: string;         // key in the deploy JSON pointing at the repo
  ensField?: string;         // ENS name key
  maintainerField?: string;  // maintainer address key
  // Extra keys in the deploy JSON that map to entries in
  // `plugins.<slot>.other` (chain-scoped auxiliary addresses).
  other?: Record<string, string>;
};

const PER_DEPLOY_SOURCES: PluginDeployConfig[] = [
  {
    component: "lock-to-vote-plugin",
    slot: "lock-to-vote",
    repoField: "lockToVotePluginRepo",
    ensField: "lockToVoteEnsDomain",
    maintainerField: "pluginRepoMaintainer",
  },
  {
    component: "token-voting-plugin",
    slot: "token-voting",
    repoField: "pluginRepo",
    other: {
      governanceERC20: "governanceERC20",
      governanceWrappedERC20: "governanceWrappedERC20",
    },
  },
  // admin/multisig/spp don't emit per-deploy JSONs in the artifacts/ folder yet.
];

export async function fromPerDeployOverlays(): Promise<Partial[]> {
  const out: Partial[] = [];
  for (const cfg of PER_DEPLOY_SOURCES) {
    const dir = resolve(REPO_ROOT, cfg.component, "artifacts");
    const files = await latestPerSlug(dir, /^deployment-(.+)-(\d+)\.json$/);
    for (const [slug, path] of files) {
      const chainId = slugToChainId(slug);
      if (!chainId) continue;
      const j = await readJson<Record<string, string>>(path);
      if (!j) continue;

      const repo = j[cfg.repoField];
      if (!repo) continue;

      const plugin: Record<string, unknown> = { repo };
      if (cfg.ensField && j[cfg.ensField]) plugin.ens = j[cfg.ensField];
      if (cfg.maintainerField && j[cfg.maintainerField]) plugin.maintainer = j[cfg.maintainerField];

      const other: Record<string, string> = {};
      for (const [outKey, srcKey] of Object.entries(cfg.other ?? {})) {
        if (j[srcKey]) other[outKey] = j[srcKey];
      }
      if (Object.keys(other).length) plugin.other = other;

      out.push({
        chainId,
        fragment: {
          chainId,
          plugins: { [cfg.slot]: plugin } as Partial["fragment"]["plugins"],
        },
      });
    }
  }
  return out;
}

// ─── log helpers ────────────────────────────────────────────────────────────

// Called once at the top of sync so the user can see which files were considered
// but dropped (testnets, unknown slugs). Useful for catching typos / new chains.
export async function reportUnknownSlugs(): Promise<void> {
  const seen = new Set<string>();
  // gather from every flat-map source
  for (const src of FLAT_PLUGIN_SOURCES) {
    for (const rel of src.paths) {
      const j = await readJson<Record<string, Record<string, string>>>(resolve(REPO_ROOT, rel));
      if (!j?.[src.topKey]) continue;
      for (const slug of Object.keys(j[src.topKey])) seen.add(slug);
    }
  }
  const cond = await readJson<Record<string, Record<string, string>>>(
    resolve(REPO_ROOT, "condition-library", "npm-artifacts", "src", "addresses.json"),
  );
  if (cond?.conditionFactory) for (const s of Object.keys(cond.conditionFactory)) seen.add(s);
  const osx = await readJson<Record<string, Record<string, string>>>(
    resolve(REPO_ROOT, "osx", "npm-artifacts", "src", "addresses.json"),
  );
  if (osx) for (const v of Object.values(osx)) for (const s of Object.keys(v)) seen.add(s);

  const unknown: string[] = [];
  for (const s of seen) if (classifySlug(s) === "unknown") unknown.push(s);
  if (unknown.length) {
    console.error(`  [network-map] unknown slugs (not mainnet, not testnet): ${unknown.join(", ")}`);
    console.error(`  ↳ add them to lib/network-map.ts if they're real mainnets.`);
  }
}
