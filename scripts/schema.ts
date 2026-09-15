import { z } from "zod";

// Ethereum address. Lowercased on parse — checksums are display-only, not identity,
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

// The OSx framework itself: factories, registries, PSP. memberRegistry* is
// mainnet-only. Everything optional so a partially-known snapshot still validates.
export const OsxCore = z
  .object({
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
// they're auxiliary contracts protocol-factory installs to smooth out plugin
// installation (placeholderSetup) and delegatecall execution (globalExecutor).
// Extendable via free-form keys as new helpers appear across versions.
export const OsxHelpers = z
  .object({
    globalExecutor: Address.optional(),
    placeholderSetup: Address.optional(),
  })
  .catchall(Address)
  .default({});

// One OSx protocol version snapshot. protocolVersion is the string returned by
// DAOFactory.protocolVersion() ("major.minor.patch"). Additive: leave older
// versions in place when a new one lands.
export const OsxVersion = z.object({
  protocolVersion: z.string(),
  core: OsxCore,
  helpers: OsxHelpers,
});

// A single (release, build) of a plugin. `setup` is required (that's what
// PluginRepo.getVersion returns). `implementation` is optional because some
// plugin patterns don't have a distinct impl address.
export const PluginVersion = z.object({
  release: z.number().int().positive(),
  build: z.number().int().positive(),
  setup: Address,
  implementation: Address.optional(),
  // Additional addresses associated with this plugin version — canonical
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
// `versions` may be empty when the repo exists but we haven't yet snapshotted
// its on-chain releases.
export const Plugin = z
  .object({
    repo: Address,
    ens: z.string().optional(),
    maintainer: Address.optional(),
    versions: z.array(PluginVersion).default([]),
    current: ReleaseBuild.optional(),
  })
  .refine(
    (p) =>
      !p.current ||
      p.versions.some(
        (v) =>
          v.release === p.current!.release && v.build === p.current!.build,
      ),
    { message: "current release.build must exist in versions[]" },
  );

// The OSx-managed DAO that governs upgrades and permissions of the protocol
// itself on this chain. Deployed once; upgraded in place — no versions[].
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

// Per-chain address book. Only chainId + network are strictly required; every
// other section defaults to empty so a partially populated chain still validates.
//
//   osx         — framework snapshots (versioned)
//   management  — the protocol's own governing DAO + multisig
//   ens         — ENS stack (chains with ENS-based naming only)
//   plugins     — plugin repos keyed by slug ("lock-to-vote", "token-voting", …)
//   shared      — chain-global helpers that don't belong to a specific plugin
//                 (governance token templates, condition factories, …)
//   deployers   — one-shot deployment tools (protocolFactory, …). Lifecycle
//                 artefacts, not runtime contracts.
export const AddressBook = z.object({
  chainId: ChainId,
  network: z.string(),
  osx: z
    .object({
      versions: z.array(OsxVersion).default([]),
      current: z.string().optional(),
    })
    .refine(
      (x) =>
        !x.current || x.versions.some((v) => v.protocolVersion === x.current),
      { message: "current protocolVersion must exist in versions[]" },
    )
    .optional(),
  management: Management.optional(),
  ens: Ens.optional(),
  plugins: z.record(z.string(), Plugin).default({}),
  shared: z.record(z.string(), Address).default({}),
  deployers: z.record(z.string(), Address).default({}),
});

export type AddressBook = z.infer<typeof AddressBook>;
export type Plugin = z.infer<typeof Plugin>;
export type PluginVersion = z.infer<typeof PluginVersion>;
export type OsxVersion = z.infer<typeof OsxVersion>;
export type Management = z.infer<typeof Management>;
export type Ens = z.infer<typeof Ens>;
