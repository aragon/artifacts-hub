// Plugin-side constants that are the same on every chain the plugin ships to:
// the canonical ENS subdomain (relative to `plugin.dao.eth`), the display name,
// and the ABI names (in `abi/<slug>/v<release>.<build>/`) of the contracts a
// PluginRepo version points to. If a chain uses a different ENS name for a
// given plugin, the per-chain `plugins.<slug>.ens` value overrides.

export type PluginCatalogEntry = {
  ens: string;
  label: string;
  abi: { implementation: string; setup: string };
};

export const PLUGIN_CATALOG: Record<string, PluginCatalogEntry> = {
  admin: {
    ens: "admin.plugin.dao.eth",
    label: "Admin",
    abi: { implementation: "Admin", setup: "AdminSetup" },
  },
  multisig: {
    ens: "multisig.plugin.dao.eth",
    label: "Multisig",
    abi: { implementation: "Multisig", setup: "MultisigSetup" },
  },
  "token-voting": {
    ens: "token-voting.plugin.dao.eth",
    label: "Token Voting",
    abi: { implementation: "TokenVoting", setup: "TokenVotingSetup" },
  },
  spp: {
    ens: "staged-proposal-processor.plugin.dao.eth",
    label: "Staged Proposal Processor",
    abi: { implementation: "StagedProposalProcessor", setup: "StagedProposalProcessorSetup" },
  },
  "lock-to-vote": {
    ens: "lock-2-vote.plugin.dao.eth",
    label: "Lock to Vote",
    abi: { implementation: "LockToVotePlugin", setup: "LockToVotePluginSetup" },
  },
  crosschain: {
    ens: "crosschain.plugin.dao.eth",
    label: "Cross-Chain Controller",
    abi: { implementation: "CrossChainController", setup: "CrossChainControllerSetup" },
  },
};

export function ensForSlug(slug: string): string | undefined {
  return PLUGIN_CATALOG[slug]?.ens;
}
