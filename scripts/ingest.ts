// Ingest a single chain from its ProtocolFactory address. Reconstructs the
// entire AddressBook by on-chain queries — no upstream JSON files, no manual
// overlays. Writes addresses/<chainId>.json plus a <network>.json symlink.
//
// Usage:
//   just ingest <chainId> <rpcUrl> <protocolFactoryAddress> [networkName]
//
// The network name defaults to the chainId as a string; pass something human
// (`citrea`, `hemi`, …) so the symlink reads nicely. Overwrites any existing
// file for the chain — the PF snapshot is authoritative for chains that have
// one, and re-running produces the same output modulo new plugin versions.

import { resolve } from "@std/path";
import { createPublicClient, http, parseAbi, type Address, type Hex } from "viem";
import { AddressBook } from "./schema.ts";
import { readProtocolFactory, readProtocolVersion } from "./lib/read-protocol-factory.ts";
import { readAllPluginRepoVersions } from "./lib/read-plugin-repo.ts";
import { resolveEns } from "./lib/resolve-ens.ts";
import { ensForSlug } from "./lib/plugin-catalog.ts";

const HERE = import.meta.dirname!;
const ADDRESSES_DIR = resolve(HERE, "..", "addresses");
const ZERO = "0x0000000000000000000000000000000000000000";

// PF struct field → AddressBook.plugins slug.
const PLUGIN_MAP = [
  { slug: "admin", field: "adminPluginRepo" },
  { slug: "multisig", field: "multisigPluginRepo" },
  { slug: "token-voting", field: "tokenVotingPluginRepo" },
  { slug: "spp", field: "stagedProposalProcessorPluginRepo" },
  { slug: "lock-to-vote", field: "lockToVotePluginRepo" },
] as const;

async function main() {
  const [chainIdStr, rpc, factoryStr, networkArg] = Deno.args;
  if (!chainIdStr || !rpc || !factoryStr) {
    console.error("usage: ingest <chainId> <rpcUrl> <protocolFactoryAddress> [networkName]");
    Deno.exit(2);
  }
  const chainId = Number(chainIdStr);
  const network = networkArg ?? String(chainId);
  const protocolFactory = factoryStr as Address;

  console.error(`ingesting chain ${chainId} (${network}) via ProtocolFactory ${protocolFactory}`);

  // Step 1: getDeployment() → whole-chain snapshot.
  const d = await readProtocolFactory(rpc, protocolFactory);
  if (!d.daoFactory) throw new Error("ProtocolFactory.getDeployment returned no daoFactory");

  // Step 2: protocolVersion + daoBase via DAOFactory.
  let protocolVersion = "unknown";
  try {
    protocolVersion = await readProtocolVersion(rpc, d.daoFactory);
  } catch { /* leave "unknown"; some chains stub it */ }
  const daoBase = await readDaoBase(rpc, d.daoFactory);

  // Step 3: recover lockToVotePluginRepo via ENS if the PF is a v1 struct.
  if (!d.lockToVotePluginRepo && d.ensRegistry) {
    try {
      d.lockToVotePluginRepo = await resolveEns(rpc, d.ensRegistry, "lock-2-vote.plugin.dao.eth");
    } catch { /* ignore */ }
  }

  // Build the initial AddressBook shape.
  const book: AddressBook = {
    chainId,
    network,
    osx: {
      versions: [{
        protocolVersion,
        core: {
          daoBase,
          daoFactory: d.daoFactory,
          daoRegistry: d.daoRegistry,
          pluginRepoFactory: d.pluginRepoFactory,
          pluginRepoRegistry: d.pluginRepoRegistry,
          pluginSetupProcessor: d.pluginSetupProcessor,
        },
        helpers: {
          globalExecutor: d.globalExecutor,
          placeholderSetup: d.placeholderSetup,
        },
        current: true,
      }],
    },
    management: {
      dao: d.managementDao,
      daoMultisig: d.managementDaoMultisig,
    },
    ens: {
      registry: d.ensRegistry,
      daoSubdomainRegistrar: d.daoSubdomainRegistrar,
      pluginSubdomainRegistrar: d.pluginSubdomainRegistrar,
      publicResolver: d.publicResolver,
    },
    plugins: {},
    ...(d.conditionFactory
      ? { conditions: { factories: [{ address: d.conditionFactory, current: true }] } }
      : {}),
    deployers: { protocolFactory },
  };

  // Step 4: for each plugin repo, enumerate on-chain versions + fill defaults.
  for (const { slug, field } of PLUGIN_MAP) {
    const repo = d[field] as Address | undefined;
    if (!repo || repo.toLowerCase() === ZERO) continue;
    const plugin: import("./schema.ts").Plugin = {
      repo,
      ens: ensForSlug(slug),
      maintainer: d.managementDao,
      versions: [],
    };
    try {
      const versions = await readAllPluginRepoVersions(rpc, repo);
      plugin.versions = versions.map((v, i) => ({
        release: v.release,
        build: v.build,
        setup: v.setup,
        implementation: v.implementation,
        ...(i === versions.length - 1 ? { current: true } : {}),
      }));
    } catch (e) {
      console.error(`  ! ${slug}.versions: ${(e as Error).message}`);
    }
    book.plugins[slug] = plugin;
  }

  // Step 5: token-voting exposes governance-token base impls on its current setup.
  await fillTokenVotingTemplates(book, rpc);

  // Step 6: publicResolver from ENS. ENS section already carries three fields
  // from PF; the fourth (publicResolver) comes from ENSRegistry.resolver(node).
  await fillPublicResolver(book, rpc);

  // Zod-validate to guarantee the emitted JSON is schema-clean.
  const parsed = AddressBook.parse(book);
  const outPath = resolve(ADDRESSES_DIR, `${chainId}.json`);
  await Deno.writeTextFile(outPath, JSON.stringify(parsed, null, 2) + "\n");

  const linkPath = resolve(ADDRESSES_DIR, `${network}.json`);
  try { await Deno.remove(linkPath); } catch { /* ok */ }
  await Deno.symlink(`${chainId}.json`, linkPath);

  console.error(`wrote ${outPath} (+ ${network}.json symlink)`);
}

// --- helpers -----------------------------------------------------------------

async function readDaoBase(rpc: string, daoFactory: Address): Promise<Address | undefined> {
  try {
    const client = createPublicClient({ transport: http(rpc) });
    return await client.readContract({
      address: daoFactory,
      abi: parseAbi(["function daoBase() view returns (address)"]),
      functionName: "daoBase",
    }) as Address;
  } catch {
    return undefined;
  }
}

async function fillTokenVotingTemplates(book: AddressBook, rpc: string): Promise<void> {
  const tv = book.plugins["token-voting"];
  const setup = tv?.versions?.[tv.versions.length - 1]?.setup as Address | undefined;
  if (!tv || !setup) return;

  const client = createPublicClient({ transport: http(rpc) });
  const abi = parseAbi([
    "function governanceERC20Base() view returns (address)",
    "function governanceWrappedERC20Base() view returns (address)",
  ]);
  const readMaybe = async (fn: "governanceERC20Base" | "governanceWrappedERC20Base") => {
    try { return await client.readContract({ address: setup, abi, functionName: fn }) as Address; }
    catch { return undefined; }
  };

  const [erc20, wrapped] = await Promise.all([
    readMaybe("governanceERC20Base"),
    readMaybe("governanceWrappedERC20Base"),
  ]);
  if (erc20 || wrapped) {
    tv.other = tv.other ?? {};
    if (erc20) tv.other.governanceERC20 = erc20;
    if (wrapped) tv.other.governanceWrappedERC20 = wrapped;
  }
}

async function fillPublicResolver(book: AddressBook, rpc: string): Promise<void> {
  const registry = book.ens?.registry as Address | undefined;
  const registrar = (book.ens?.pluginSubdomainRegistrar ?? book.ens?.daoSubdomainRegistrar) as Address | undefined;
  if (!registry || !registrar || book.ens?.publicResolver) return;

  const client = createPublicClient({ transport: http(rpc) });
  const registrarAbi = parseAbi(["function node() view returns (bytes32)"]);
  const registryAbi = parseAbi(["function resolver(bytes32) view returns (address)"]);

  try {
    const node = await client.readContract({ address: registrar, abi: registrarAbi, functionName: "node" }) as Hex;
    const resolver = await client.readContract({ address: registry, abi: registryAbi, functionName: "resolver", args: [node] }) as Address;
    if (resolver && resolver.toLowerCase() !== ZERO) {
      book.ens!.publicResolver = resolver;
    }
  } catch { /* leave empty; some chains omit ENS naming */ }
}

await main();
