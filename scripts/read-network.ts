// Read a chain's on-chain state (via ProtocolFactory.getDeployment) and emit a
// fully-populated AddressBook to addresses/<chainId>.json.
//
// Usage:
//   deno task read-network <chainId>
//   deno task read-network <chainId> <rpcUrl> <protocolFactoryAddress> [networkName]
//
// With just a chainId, the RPC and ProtocolFactory address are pulled from the
// matching just-foundry env file (../../just-foundry/networks/<name>.env). With
// the extra args, all lookup is skipped.

import { resolve } from "@std/path";
import { AddressBook } from "./schema.ts";
import { readProtocolFactory, readProtocolVersion } from "./lib/read-protocol-factory.ts";
import { readAllPluginRepoVersions } from "./lib/read-plugin-repo.ts";
import { resolveEns } from "./lib/resolve-ens.ts";

const HERE = import.meta.dirname!;
const ADDRESSES_DIR = resolve(HERE, "..", "addresses");
const NETWORKS_DIR = resolve(HERE, "..", "..", "just-foundry", "networks");

// Match plugin repo slug in AddressBook against the field name on Deployment.
// The slug is what will be published to NPM ("import { addresses } from …"), so
// keep it kebab-case and match Aragon's shipped naming.
const PLUGIN_MAP: Array<{ slug: string; field: keyof Awaited<ReturnType<typeof readProtocolFactory>> }> = [
  { slug: "admin", field: "adminPluginRepo" },
  { slug: "multisig", field: "multisigPluginRepo" },
  { slug: "token-voting", field: "tokenVotingPluginRepo" },
  { slug: "spp", field: "stagedProposalProcessorPluginRepo" },
  { slug: "lock-to-vote", field: "lockToVotePluginRepo" },
];

async function findEnvFor(chainId: number): Promise<{
  network: string;
  rpc: string;
  protocolFactory?: string;
}> {
  for await (const entry of Deno.readDir(NETWORKS_DIR)) {
    if (!entry.isFile || !entry.name.endsWith(".env")) continue;
    const text = await Deno.readTextFile(resolve(NETWORKS_DIR, entry.name));
    const kv: Record<string, string> = {};
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*"?([^"]*)"?\s*$/);
      if (m) kv[m[1]] = m[2];
    }
    if (Number(kv.CHAIN_ID) === chainId) {
      return {
        network: kv.NETWORK_NAME || entry.name.replace(/\.env$/, ""),
        rpc: kv.RPC_URL,
        protocolFactory: kv.PROTOCOL_FACTORY_ADDRESS || undefined,
      };
    }
  }
  throw new Error(`no just-foundry env matches chainId=${chainId}`);
}

async function main() {
  const [chainIdStr, rpcArg, factoryArg, networkArg] = Deno.args;
  if (!chainIdStr) {
    console.error("usage: read-network <chainId> [<rpcUrl> <protocolFactory> [network]]");
    Deno.exit(2);
  }
  const chainId = Number(chainIdStr);

  let rpc: string, protocolFactory: string | undefined, network: string;
  if (rpcArg && factoryArg) {
    rpc = rpcArg;
    protocolFactory = factoryArg;
    network = networkArg ?? String(chainId);
  } else {
    const env = await findEnvFor(chainId);
    rpc = env.rpc;
    protocolFactory = env.protocolFactory;
    network = env.network;
  }

  if (!protocolFactory) {
    console.error(
      `chain ${chainId} (${network}) has no protocol factory address; ` +
        "fall back to the env-hunting path (not implemented yet) or pass one on the CLI.",
    );
    Deno.exit(3);
  }

  console.error(`reading chain ${chainId} (${network}) via ProtocolFactory ${protocolFactory}`);

  const d = await readProtocolFactory(rpc, protocolFactory as `0x${string}`);
  const daoFactory = d.daoFactory;
  if (!daoFactory) throw new Error("ProtocolFactory returned no daoFactory");
  const protocolVersion = await readProtocolVersion(rpc, daoFactory);

  // Older ProtocolFactories (like Citrea's) predate the lockToVotePluginRepo
  // field on the Deployment struct. Recover it via ENS resolution when possible.
  if (!d.lockToVotePluginRepo && d.ensRegistry) {
    try {
      d.lockToVotePluginRepo = await resolveEns(
        rpc,
        d.ensRegistry,
        "lock-2-vote.plugin.dao.eth",
      );
    } catch { /* leave undefined */ }
  }

  const book: AddressBook = {
    chainId,
    network,
    osx: {
      versions: [
        {
          protocolVersion,
          core: {
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
        },
      ],
      current: protocolVersion,
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
    shared: {},
    deployers: { protocolFactory },
  };

  // Enrich each plugin with its on-chain versions. Runs sequentially — RPC
  // rate-limits and getDeployment already gave us the repos, so this is the only
  // network-heavy step. If it turns out slow, parallelise later.
  for (const { slug, field } of PLUGIN_MAP) {
    const repo = d[field] as `0x${string}` | undefined;
    if (!repo || /^0x0{40}$/i.test(repo.slice(2))) continue;
    const versions = await readAllPluginRepoVersions(rpc, repo);
    const latest = versions[versions.length - 1];
    book.plugins[slug] = {
      repo,
      maintainer: d.managementDao, // best-guess default — override per-chain if needed
      versions: versions.map((v) => ({
        release: v.release,
        build: v.build,
        setup: v.setup,
        implementation: v.implementation,
      })),
      current: latest ? { release: latest.release, build: latest.build } : undefined,
    };
  }

  // Zod-parse so the emitted JSON is guaranteed to validate on next `just validate`.
  const parsed = AddressBook.parse(book);
  const outPath = resolve(ADDRESSES_DIR, `${chainId}.json`);
  await Deno.writeTextFile(outPath, JSON.stringify(parsed, null, 2) + "\n");
  console.error(`wrote ${outPath}`);
}

await main();
