# Artifacts Hub

Canonical Aragon addresses and ABIs — one JSON per chain, one JSON per contract.
Consumed as a git submodule, no NPM, no build step.

Two symmetrical trees:

- [`addresses/`](./addresses) — `<chainId>.json` per chain, with `<network>.json` symlinks for grep-friendly names. Every file has the same shape (Zod source of truth in [`scripts/schema.ts`](./scripts/schema.ts)).
- [`abi/`](./abi) — `<component>/<Contract>.json` per contract, plus generated `index.ts` files with viem-compatible `as const` bindings.

## Get started

```bash
git submodule add https://github.com/aragon/artifacts-hub lib/artifacts-hub
```

Concrete example — resolve a plugin's current build from the address book, pair it with the ABI, make a typed viem call:

```ts
import mainnet from "./lib/artifacts-hub/addresses/mainnet.json";
import { MultisigABI } from "./lib/artifacts-hub/abi/multisig";
import { createPublicClient, http } from "viem";
import { mainnet as mainnetChain } from "viem/chains";

// From the address book:
const currentBuild = mainnet.plugins.multisig.versions.find(v => v.current)!;
// currentBuild.setup + currentBuild.implementation are the current setup contract
// and its plugin implementation on this chain.

const client = createPublicClient({ chain: mainnetChain, transport: http() });
const proposalCount = await client.readContract({
  address: "0x…YourMultisigDAOInstance…",
  abi: MultisigABI,
  functionName: "proposalCount",
});
```

Alternative import shapes:

```ts
// Grab several components under a single namespace import
import { admin, multisig, tokenVoting } from "./lib/artifacts-hub/abi";
admin.AdminABI;  tokenVoting.TokenVotingABI;

// Plain JSON when you don't need viem's `as const` inference
import Multisig from "./lib/artifacts-hub/abi/multisig/Multisig.json";
```

## `addresses/` — the address book

Every file has the same top-level shape. Common lookups:

| Want                                     | Path |
|------------------------------------------|------|
| Chain identity                           | `chainId`, `network` |
| Current OSx version                      | `osx.versions.find(v => v.current)` |
| DAO implementation (cloned by DAOFactory) | `osx.versions.find(v => v.current).core.daoBase` |
| Management DAO on this chain             | `management.dao` |
| Chain's ENSRegistry                      | `ens.registry` |
| Latest plugin build (setup + impl)       | `plugins["<slug>"].versions.find(v => v.current)` |
| All historical plugin builds             | `plugins["<slug>"].versions` |
| Governance token base (ERC20)            | `plugins["token-voting"].other.governanceERC20` |
| Current SafeOwner condition factory      | `conditions.factories.find(f => f.current).address` |
| ProtocolFactory (when the chain has one) | `deployers.protocolFactory` |

Addresses are lowercased on parse — never rely on checksum casing for identity. Arrays are ascending, and the current entry carries `current: true`.

Schema outline:

- **`osx.versions[]`** — one entry per protocol version deployed on the chain. `core.*` = the framework contracts, `helpers.*` = auxiliary singletons (`globalExecutor`; `placeholderSetup` on fresh 1.4 deploys).
- **`management.*`** — the OSx-managing DAO + its multisig plugin instance.
- **`ens.*`** — Aragon's ENS stack (registry, plugin- and dao-subdomain registrars, public resolver).
- **`plugins.<slug>`** — one entry per plugin (`admin`, `multisig`, `token-voting`, `spp`, `lock-to-vote`) with `repo`, `ens`, `maintainer`, versioned setup+impl, and optional `other{}` for plugin-scoped auxiliary addresses.
- **`conditions.factories[]`** — versioned condition factories deployed on the chain.
- **`deployers.*`** — one-shot deployment tools (currently just `protocolFactory`).

See [`addresses/README.md`](./addresses/README.md) for the tree layout and file-naming rules; [`scripts/schema.ts`](./scripts/schema.ts) is the Zod source of truth.

## `abi/` — the ABI tree

One folder per source component; one JSON per contract. Slugs match `addresses/` where applicable:

| slug            | source repo                                 |
|-----------------|---------------------------------------------|
| `osx`           | `aragon/osx`                                |
| `admin`         | `aragon/admin-plugin`                       |
| `multisig`      | `aragon/multisig-plugin`                    |
| `token-voting`  | `aragon/token-voting-plugin`                |
| `spp`           | `aragon/staged-proposal-processor-plugin`   |
| `lock-to-vote`  | `aragon/lock-to-vote-plugin`                |
| `conditions`    | `aragon/condition-library`                  |

Each folder carries a generated `index.ts` exporting every contract as `<Contract>ABI` with `as const` (viem-friendly). The top-level [`abi/index.ts`](./abi/index.ts) re-exports each component under a camelCase namespace (`lock-to-vote` → `lockToVote`, etc.).

Bytecode is deliberately omitted — pair a JSON ABI with the on-chain address from `addresses/`, or `forge build` the source repo when you need artefacts.

See [`abi/README.md`](./abi/README.md) for consuming patterns.

## Adding a new chain

Every chain deployed via **ProtocolFactory** reconstructs from a single address:

```bash
just ingest <chainId> <rpcUrl> <protocolFactoryAddress> [network]
```

That reads `getDeployment()` on the PF, calls `protocolVersion()` on the DAOFactory, enumerates every plugin repo's versions on-chain, resolves ENS, and writes `addresses/<chainId>.json` + the network symlink. Re-running is idempotent — same PF address, same output (modulo new plugin builds).

For chains that predate the ProtocolFactory (mainnet, arbitrum, base, …), the address book is hand-managed. Edit the JSON directly and let `just validate` + `just coverage` gate the changes.

## Refreshing ABIs

`just generate-abi` regenerates `abi/**/index.ts` from whatever JSONs are on disk. Run it after any hand-edit or fresh drop of an ABI JSON.

To update a component's ABIs, drop the new `<Contract>.json` files into `abi/<slug>/` and rerun `just generate-abi`.

## Commands

```bash
just validate           # Zod-validate every addresses/*.json
just coverage           # per-network table + section gap summary
just coverage --gaps    # invert to slot-centric view
just coverage --json    # machine-readable output for scripting
just ingest <chainId> <rpcUrl> <pfAddress> [network]
just generate-abi       # regenerate abi/**/index.ts from JSONs on disk
```

`just coverage` exits non-zero when a chain is missing a **required** slot; optional gaps (e.g. `deployers.protocolFactory` on chains that predate the PF concept) don't fail the gate. See [`scripts/coverage.ts`](./scripts/coverage.ts) for the exact required/optional split.
