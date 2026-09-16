// Slug → chainId. Every mainnet we care about, plus sepolia. Sourced from
// public chain-id knowledge; upstream JSONs use inconsistent slugs so this is
// the single point of translation.
//
// Any slug that isn't here is treated as "unknown or an intentionally-ignored
// testnet"; the sync silently drops those entries after logging counts. That
// way adding a new mainnet only requires editing this file.

const SUPPORTED_SLUGS: Record<string, number> = {
  mainnet: 1,
  arbitrum: 42161,
  avalanche: 43114,
  base: 8453,
  bsc: 56,
  celo: 42220,
  chiliz: 88888,
  citrea: 4114,
  corn: 21000000,
  hemi: 43111,
  katana: 747474,
  linea: 59144,
  mode: 34443,
  monad: 143,
  optimism: 10,
  peaq: 3338,
  polygon: 137,
  robinhood: 4663,
  zksync: 324,
  // Deliberately-included testnets. Sources use both spellings.
  sepolia: 11155111,
  "zksync-sepolia": 300,
  zksyncSepolia: 300,
};

// Known testnet aliases seen in upstream sources, dropped silently.
// Kept explicit so we can tell "known testnet" from "typo/new chain we forgot".
const KNOWN_TESTNET_SLUGS = new Set([
  "agungTestnet",
  "arbitrumSepolia",
  "arbitrum-sepolia",
  "avalancheFuji",
  "avalanche-testnet",
  "baseSepolia",
  "base-sepolia",
  "bscTestnet",
  "citrea-testnet",
  "corn-testnet",
  "holesky",
  "hoodi",
  "lineaSepolia",
  "linea-sepolia",
  "mumbai",
  "status-hoodi",
  "taiko-hoodi",
]);

export function slugToChainId(slug: string): number | undefined {
  return SUPPORTED_SLUGS[slug];
}

export function classifySlug(slug: string): "supported" | "testnet" | "unknown" {
  if (slug in SUPPORTED_SLUGS) return "supported";
  if (KNOWN_TESTNET_SLUGS.has(slug)) return "testnet";
  return "unknown";
}

export function allSupportedChainIds(): number[] {
  return [...new Set(Object.values(SUPPORTED_SLUGS))].sort((a, b) => a - b);
}
