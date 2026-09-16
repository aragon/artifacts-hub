# artifacts

Canonical address book for Aragon deployments across every chain the protocol runs on.
One file per chain, always at `addresses/<chainId>.json`; each has a `<network>.json`
symlink pointing at it so humans can grep by name.

## Consuming

```ts
import citrea from "aragon/artifacts/addresses/4114.json";
// or:
import citrea from "aragon/artifacts/addresses/citrea.json";
```

Every file has the same shape (see `scripts/schema.ts` for the Zod source of
truth). Quick lookup table:

| Want                              | Path |
|-----------------------------------|------|
| Chain identity                    | `chainId`, `network` |
| Current OSx version               | `osx.versions.find(v => v.current)` |
| OSx `DAOFactory` address          | `osx.versions.find(v => v.current).core.daoFactory` |
| DAO implementation cloned by factory | `osx.versions.find(v => v.current).core.daoBase` |
| Management DAO on this chain      | `management.dao` |
| Chain's ENSRegistry               | `ens.registry` |
| Latest LTV plugin (setup + impl)  | `plugins["lock-to-vote"].versions.find(v => v.current)` |
| All historical LTV builds         | `plugins["lock-to-vote"].versions` |
| Governance token base (ERC20)     | `plugins["token-voting"].other.governanceERC20` |
| Current SafeOwner condition factory | `conditions.factories.find(f => f.current).address` |
| ProtocolFactory (if any)          | `deployers.protocolFactory` |

Every address is lowercased on parse — never rely on checksum casing for
identity. `versions[]` and `factories[]` are written in ascending order; the
last entry is marked `current: true`.

## Schema at a glance

- **`chainId`, `network`** — mandatory. Network is the kebab-case slug used by just-foundry.
- **`osx.versions[]`** — one entry per protocol version deployed on this chain.
  - `core.*` — `daoBase, daoFactory, daoRegistry, pluginRepo{Factory,Registry}, pluginSetupProcessor` plus `memberRegistry` on mainnet only.
  - `helpers.*` — chain-scoped OSx helpers (`globalExecutor`; `placeholderSetup` on fresh 1.4 deploys).
- **`management`** — the OSx-managing DAO + its multisig plugin instance.
- **`ens`** — Aragon's ENS stack: registry, plugin- and dao-subdomain registrars, public resolver.
- **`plugins`** — one entry per plugin slug (`admin, multisig, token-voting, spp, lock-to-vote`). Each carries `repo, ens, maintainer, versions[]` and optionally `other{}` (plugin-scoped auxiliary addresses like the governance token bases for token-voting).
- **`conditions.factories[]`** — versioned SafeOwner (and future) condition factories deployed on the chain.
- **`deployers`** — one-shot deployment tools (currently `protocolFactory`).

## Adding a new chain

Every chain deployed via **ProtocolFactory** reconstructs from a single address:

```bash
just ingest <chainId> <rpcUrl> <protocolFactoryAddress> [network]
```

That reads `getDeployment()` on the PF, calls `protocolVersion()` on the
DAOFactory, enumerates every plugin repo's versions on-chain, resolves ENS,
and writes `addresses/<chainId>.json` + the network symlink. Re-running is
idempotent — same PF address, same output (modulo new plugin builds).

For older chains without a ProtocolFactory (mainnet, arbitrum, base, …), the
address book is hand-managed. Edit the JSON directly and let `just validate`
+ `just coverage` gate the changes.

## Commands

```bash
just validate           # Zod-validate every addresses/*.json
just coverage           # per-network table + section gap summary
just coverage --gaps    # invert to slot-centric view (every empty slot + which chains)
just coverage --json    # machine-readable output for scripting
just ingest …           # ProtocolFactory-based ingest (see above)
```

`just coverage` exits non-zero when any chain has a **required** slot missing;
`optional` gaps (e.g. `deployers.protocolFactory` on pre-PF chains) don't fail.
See `scripts/coverage.ts` for the exact required/optional split.
