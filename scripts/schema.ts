import { z } from "zod";

// Ethereum address. Lowercased on parse: checksums are display-only, not identity,
// so we normalise here to make cross-file comparison trivial.
export const Address = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/, "must be a 20-byte hex address")
  .transform((s) => s.toLowerCase());

export const ChainId = z.number().int().positive();

// PluginRepo (release, build) — Aragon's on-chain version identity for a plugin.
export const ReleaseBuild = z.object({
  release: z.number().int().positive(),
  build: z.number().int().positive(),
});

// The OSx framework itself: factories, registries, PSP, and the DAO
// implementation that DAOFactory clones ("daoBase": distinct from a specific
// management DAO instance, which lives under `management.dao`).
// memberRegistry* is mainnet-only. Everything optional so a partial snapshot
// still validates.
export const OsxCore = z
  .object({
    daoBase: Address.optional(),
    daoFactory: Address.optional(),
    daoRegistry: Address.optional(),
    pluginRepoFactory: Address.optional(),
    pluginRepoRegistry: Address.optional(),
    pluginSetupProcessor: Address.optional(),
    memberRegistry: Address.optional(),
    memberRegistryProxy: Address.optional(),
  })
  .default({});

// Singleton helpers deployed alongside a specific OSx version. Not part of core:
// auxiliary contracts protocol-factory installs for delegatecall execution
// (globalExecutor). Placeholder setups are not tracked here: each plugin build
// that uses one carries `placeholder: true` instead.
export const OsxHelpers = z
  .object({
    globalExecutor: Address.optional(),
  })
  .default({});

// One OSx protocol version snapshot. protocolVersion is the string returned by
// DAOFactory.protocolVersion() ("major.minor.patch"). Additive: leave older
// versions in place when a new one lands. `current: true` marks the version
// that's live now; enrichment stamps it on the last entry of the ascending
// versions[] array so consumers can `versions.find(v => v.current)`.
export const OsxVersion = z.object({
  protocolVersion: z.string(),
  core: OsxCore,
  helpers: OsxHelpers,
  current: z.boolean().optional(),
});

// A single (release, build) of a plugin. `setup` is required (that's what
// PluginRepo.getVersion returns). `implementation` is absent when the setup
// has no distinct impl (placeholders, zkSync Admin); it is never 0x0.
// `placeholder: true` marks a build whose setup is an OSx PlaceholderSetup
// (published only to keep build numbers aligned across chains): not the
// plugin, never installable, never `current`. `current: true` is set on the
// highest non-placeholder release/build, so consumers can do
// `versions.find(v => v.current)` instead of `versions[versions.length - 1]`.
export const PluginVersion = z.object({
  release: z.number().int().positive(),
  build: z.number().int().positive(),
  setup: Address,
  implementation: Address.refine((a) => !/^0x0{40}$/.test(a), "zero address: omit implementation instead").optional(),
  placeholder: z.literal(true).optional(),
  current: z.boolean().optional(),
  // Additional addresses associated with this plugin version: canonical
  // LockManager, shipped conditions, helper singletons, whatever the plugin
  // needs. Free-form keys keep the schema stable across plugins.
  other: z.record(z.string(), Address).optional(),
  metadata: z
    .object({
      release: z.string().optional(),
      build: z.string().optional(),
    })
    .partial()
    .optional(),
});

// One Aragon plugin as it lives on a chain: one PluginRepo, N versions.
// versions[] is written in ascending release/build order; the last entry has
// `current: true` under Aragon's rolling-release model.
//
// `other` carries chain-scoped auxiliary addresses tied to this plugin but not
// to any specific release/build: canonical templates, singleton helpers,
// factory outputs. (Per-version helpers live under `PluginVersion.other`
// instead; different lifetime.)
export const Plugin = z.object({
  repo: Address,
  ens: z.string().optional(),
  maintainer: Address.optional(),
  versions: z.array(PluginVersion).default([]),
  other: z.record(z.string(), Address).optional(),
});

// The OSx-managed DAO that governs upgrades and permissions of the protocol
// itself on this chain. Deployed once; upgraded in place: no versions[].
// daoMultisig is the specific Multisig plugin instance that governs `dao`.
export const Management = z
  .object({
    dao: Address.optional(),
    daoMultisig: Address.optional(),
  })
  .default({});

// ENS stack on chains where OSx uses ENS-based naming (mainnet + several L2s).
// Separate from OSx `core` because it's chain-global infra, one instance per
// chain regardless of OSx protocol version.
export const Ens = z
  .object({
    registry: Address.optional(),
    daoSubdomainRegistrar: Address.optional(),      // owns *.dao.eth
    pluginSubdomainRegistrar: Address.optional(),   // owns *.plugin.dao.eth
    publicResolver: Address.optional(),
  })
  .default({});

// A ConditionFactory deployment. Aragon bumps the factory whenever a new
// condition type ships (each newer factory can instantiate more kinds), so
// factories[] is an ascending version list. The last entry gets `current: true`
// stamped by enrich. `version` is optional because upstream doesn't yet publish
// a version tag alongside the address.
export const ConditionFactoryVersion = z.object({
  version: z.string().optional(),
  address: Address,
  current: z.boolean().optional(),
});

export const Conditions = z
  .object({
    factories: z.array(ConditionFactoryVersion).default([]),
  })
  .default({ factories: [] });

// Per-chain address book. Only chainId + network are strictly required; every
// other section defaults to empty so a partially populated chain still validates.
//
//   osx         — framework snapshots (versioned)
//   management  — the protocol's own governing DAO + multisig
//   ens         — ENS stack (chains with ENS-based naming only)
//   plugins     — plugin repos keyed by slug ("lock-to-vote", "token-voting", …)
//                 Plugin-scoped helpers/templates go under `plugins.<slug>.other`.
//   conditions  — chain-scoped condition factories (versioned)
//   deployers   — one-shot deployment tools (protocolFactory, …). Lifecycle
//                 artefacts, not runtime contracts.
export const AddressBook = z.object({
  chainId: ChainId,
  network: z.string(),
  // When true, the chain is retired: entries stay so consumers can still
  // resolve historical addresses, but `coverage.ts` excludes it from the
  // required-slot gate and no new plugin ingest should target it.
  deprecated: z.boolean().optional(),
  osx: z
    .object({
      versions: z.array(OsxVersion).default([]),
    })
    .optional(),
  management: Management.optional(),
  ens: Ens.optional(),
  plugins: z.record(z.string(), Plugin).default({}),
  conditions: Conditions.optional(),
  deployers: z.record(z.string(), Address).default({}),
});

// Per-deployment envelope emitted by a plugin repo's deploy script into
// `<plugin>/artifacts/artifacts-<network>-<timestamp>.json`. Self-describing so
// an ingest step can merge it into `addresses/<chainId>.json` without inferring
// anything from the filename: `chainId` picks the target file, `slug` picks the
// entry under `plugins.<slug>`, and `plugin` is exactly the AddressBook Plugin
// subtree (same schema, drop-in mergeable).
//
// `timestamp` is the block.timestamp at deployment (seconds). One file per
// deployment; ingest is expected to overwrite prior artifacts for the same
// (chainId, slug) or append a version to `plugin.versions` under Aragon's
// rolling-release model.
export const PluginArtifact = z.object({
  chainId: ChainId,
  network: z.string(),
  timestamp: z.number().int().nonnegative(),
  slug: z.string(),
  plugin: Plugin,
});

export type AddressBook = z.infer<typeof AddressBook>;
export type Plugin = z.infer<typeof Plugin>;
export type PluginVersion = z.infer<typeof PluginVersion>;
export type OsxVersion = z.infer<typeof OsxVersion>;
export type Management = z.infer<typeof Management>;
export type Ens = z.infer<typeof Ens>;
export type PluginArtifact = z.infer<typeof PluginArtifact>;

// abi/sources.json: where each versioned ABI folder comes from. Keyed by
// component slug, then by version folder name (`v1.2`, `v1.4.0`).
//   npm:<package>@<version>      — a published package; ABIs are read from its
//                                  `<Name>ABI` exports or TypeChain `<Name>__factory.abi`.
//   git:<https url>#<commit sha> — cloned, `forge build`, every non-abstract
//                                  contract, interface and library declared under
//                                  `src/` with a non-empty ABI.
// `contracts` narrows a source that bundles more than this component (e.g.
// the pre-split `@aragon/osx-ethers` packages carried the plugins too). npm
// packages say nothing about abstract contracts, so their list must leave them out.
export const AbiVersionDir = z.string().regex(/^v\d+(\.\d+)+$/, "must look like v1.2 or v1.4.0");
export const AbiSource = z.object({
  source: z.union([
    z.string().regex(/^npm:(@[\w.-]+\/)?[\w.-]+@\d+\.\d+\.\d+$/, "npm:<package>@<x.y.z>"),
    z.string().regex(/^git:https:\/\/[^#\s]+#[0-9a-f]{40}$/, "git:<https url>#<40-char sha>"),
  ]),
  contracts: z.array(z.string().regex(/^\w+$/)).nonempty().optional(),
}).strict();
export const AbiSources = z.record(z.string(), z.record(AbiVersionDir, AbiSource));

export type AbiSource = z.infer<typeof AbiSource>;
export type AbiSources = z.infer<typeof AbiSources>;

// First issue of a failed parse as "path.to.field: message", for one-line CLI errors.
export function firstZodError(err: z.ZodError): string {
  const i = err.issues[0];
  if (!i) return "unknown parse error";
  const p = i.path.length ? i.path.map(String).join(".") : "(root)";
  return `${p}: ${i.message}`;
}
