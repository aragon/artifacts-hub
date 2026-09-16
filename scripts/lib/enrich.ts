// On-chain enrichment: given a partially-populated AddressBook and an RPC URL,
// query the chain to fill:
//   • osx.versions[0].protocolVersion   (from any Aragon `ProtocolVersion`
//     implementer: daoFactory or any pluginRepo)
//   • plugins.<slug>.versions[]         (from PluginRepo.getVersion())
//   • plugins.<slug>.versions[].implementation (from setup.implementation())
//   • plugins.<slug>.current            (highest release/build)
//   • plugins.lock-to-vote.repo via ENS (fallback for chains where the ENS name
//     is claimed but the PF snapshot didn't include it)
//
// Nothing else is inferred; missing addresses remain missing.

import { createPublicClient, http, parseAbi, type Address } from "viem";
import type { AddressBook } from "../schema.ts";
import { readAllPluginRepoVersions } from "./read-plugin-repo.ts";
import { readProtocolVersion } from "./read-protocol-factory.ts";
import { resolveEns } from "./resolve-ens.ts";
import { ensForSlug } from "./plugin-catalog.ts";

const ZERO = "0x0000000000000000000000000000000000000000";

type Partial<T> = { [K in keyof T]?: T[K] };

// Best-effort. Any read that fails leaves the corresponding slot as-is.
export async function enrichOnChain(
  book: Partial<AddressBook>,
  rpcUrl: string,
): Promise<Partial<AddressBook>> {
  const errors: string[] = [];

  // protocolVersion: try DAOFactory first, fall back to any plugin repo.
  const daoFactory = book.osx?.versions?.[0]?.core?.daoFactory as Address | undefined;
  const anyPluginRepo = firstPluginRepo(book);
  const versionSource = daoFactory ?? anyPluginRepo;
  if (versionSource && !hasKnownProtocolVersion(book)) {
    try {
      const pv = await readProtocolVersion(rpcUrl, versionSource);
      const v0 = book.osx?.versions?.[0];
      if (v0) v0.protocolVersion = pv;
    } catch (e) {
      errors.push(`protocolVersion: ${(e as Error).message}`);
    }
  }

  // LTV via ENS if we have an ENS registry and no LTV repo yet.
  const ensRegistry = book.ens?.registry as Address | undefined;
  const ltv = book.plugins?.["lock-to-vote"];
  if (ensRegistry && (!ltv?.repo)) {
    try {
      const addr = await resolveEns(rpcUrl, ensRegistry, "lock-2-vote.plugin.dao.eth");
      if (addr) {
        book.plugins = book.plugins ?? {};
        book.plugins["lock-to-vote"] = { ...(ltv ?? {}), repo: addr, ens: "lock-2-vote.plugin.dao.eth" };
      }
    } catch (e) {
      errors.push(`ltv-via-ens: ${(e as Error).message}`);
    }
  }

  // Each plugin: enumerate versions on-chain and fill catalog defaults
  // (canonical ENS + management-DAO maintainer) when the source didn't say.
  if (book.plugins) {
    const managementDao = book.management?.dao as Address | undefined;
    for (const [slug, plugin] of Object.entries(book.plugins)) {
      if (!plugin || !plugin.repo || plugin.repo.toLowerCase() === ZERO) continue;

      // ENS default (constant per plugin slug across chains). Skip if the
      // source already stamped a different one: that means a chain uses a
      // non-canonical subdomain and we shouldn't clobber it.
      if (!plugin.ens) {
        const ens = ensForSlug(slug);
        if (ens) plugin.ens = ens;
      }

      // Maintainer default. Aragon's convention: management DAO owns the repo
      // unless an override is set by the deployer.
      if (!plugin.maintainer && managementDao) plugin.maintainer = managementDao;

      try {
        const versions = await readAllPluginRepoVersions(rpcUrl, plugin.repo as Address);
        if (!versions.length) continue;
        plugin.versions = versions.map((v, i) => ({
          release: v.release,
          build: v.build,
          setup: v.setup,
          implementation: v.implementation,
          ...(i === versions.length - 1 ? { current: true } : {}),
        }));
      } catch (e) {
        errors.push(`plugins.${slug}.versions: ${(e as Error).message}`);
      }
    }
  }

  // Mark the last (highest-numbered) OSx version as current, so consumers can
  // find it with `osx.versions.find(v => v.current)`.
  const osxVersions = book.osx?.versions;
  if (osxVersions && osxVersions.length) {
    for (const v of osxVersions) delete (v as { current?: boolean }).current;
    (osxVersions[osxVersions.length - 1] as { current?: boolean }).current = true;
  }

  // Same for conditions.factories (upstream publishes one entry per chain
  // today, but the loop is future-proof).
  const factories = book.conditions?.factories;
  if (factories && factories.length) {
    for (const f of factories) delete (f as { current?: boolean }).current;
    (factories[factories.length - 1] as { current?: boolean }).current = true;
  }

  // Plugin-specific enrichment: token-voting's setup exposes the governance
  // token templates (base ERC20 + base wrapped ERC20 that get cloned per DAO).
  // On chains without a per-deploy JSON these are only recoverable on-chain.
  await enrichTokenVotingTemplates(book, rpcUrl, errors);

  if (errors.length) {
    console.error(`    on-chain errors (best-effort):`);
    for (const e of errors) console.error(`      ${e}`);
  }

  return book;
}

// Reads governanceERC20Base()/governanceWrappedERC20Base() off the current
// token-voting setup and stashes them under `plugins["token-voting"].other`.
// Only fills what's missing, per-deploy sources win when present.
async function enrichTokenVotingTemplates(
  book: Partial<AddressBook>,
  rpcUrl: string,
  errors: string[],
): Promise<void> {
  const tv = book.plugins?.["token-voting"];
  const setup = tv?.versions?.[tv.versions.length - 1]?.setup as Address | undefined;
  if (!tv || !setup) return;

  const hasErc = !!tv.other?.governanceERC20;
  const hasWrapped = !!tv.other?.governanceWrappedERC20;
  if (hasErc && hasWrapped) return;

  const client = createPublicClient({ transport: http(rpcUrl) });
  const abi = parseAbi([
    "function governanceERC20Base() view returns (address)",
    "function governanceWrappedERC20Base() view returns (address)",
  ]);

  const readMaybe = async (fn: "governanceERC20Base" | "governanceWrappedERC20Base") => {
    try {
      return (await client.readContract({ address: setup, abi, functionName: fn })) as Address;
    } catch {
      return undefined;
    }
  };

  const [erc20, wrapped] = await Promise.all([
    hasErc ? Promise.resolve(undefined) : readMaybe("governanceERC20Base"),
    hasWrapped ? Promise.resolve(undefined) : readMaybe("governanceWrappedERC20Base"),
  ]);

  if (erc20 || wrapped) {
    tv.other = tv.other ?? {};
    if (erc20 && !hasErc) tv.other.governanceERC20 = erc20;
    if (wrapped && !hasWrapped) tv.other.governanceWrappedERC20 = wrapped;
  } else if (!hasErc || !hasWrapped) {
    errors.push(`plugins.token-voting.other: setup ${setup} has no governance*Base getters`);
  }
}

function firstPluginRepo(book: Partial<AddressBook>): Address | undefined {
  const plugins = book.plugins ?? {};
  for (const p of Object.values(plugins)) {
    if (p?.repo && p.repo.toLowerCase() !== ZERO) return p.repo as Address;
  }
  return undefined;
}

function hasKnownProtocolVersion(book: Partial<AddressBook>): boolean {
  const v = book.osx?.versions?.[0]?.protocolVersion;
  return !!v && v !== "unknown";
}
