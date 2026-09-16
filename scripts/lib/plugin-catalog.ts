// Plugin-side constants that are the same on every chain the plugin ships to.
// Only these two live here today: the canonical ENS subdomain (relative to
// `plugin.dao.eth`) and the display name. If a chain uses a different ENS name
// for a given plugin, the per-chain `plugins.<slug>.ens` value overrides.

export type PluginCatalogEntry = { ens: string; label: string };

export const PLUGIN_CATALOG: Record<string, PluginCatalogEntry> = {
  admin: { ens: "admin.plugin.dao.eth", label: "Admin" },
  multisig: { ens: "multisig.plugin.dao.eth", label: "Multisig" },
  "token-voting": { ens: "token-voting.plugin.dao.eth", label: "Token Voting" },
  spp: { ens: "staged-proposal-processor.plugin.dao.eth", label: "Staged Proposal Processor" },
  "lock-to-vote": { ens: "lock-2-vote.plugin.dao.eth", label: "Lock to Vote" },
};

export function ensForSlug(slug: string): string | undefined {
  return PLUGIN_CATALOG[slug]?.ens;
}
