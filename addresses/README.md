# addresses

Canonical Aragon address book — one file per chain, symmetrical shape.

## Naming

- `<chainId>.json` — the authoritative file (e.g. `4114.json`).
- `<network>.json` — a symlink to the chainId file, for human-friendly access (e.g. `citrea.json → 4114.json`).

Both work as an import target; the chainId file is what gets written.

## Shape

Every file conforms to the `AddressBook` schema defined in
[`../scripts/schema.ts`](../scripts/schema.ts). Top-level sections:

| key          | what                                                                    |
|--------------|-------------------------------------------------------------------------|
| `chainId`, `network` | chain identity |
| `osx.versions[]`     | OSx protocol snapshots — one per protocol version deployed on the chain. Current entry has `current: true`. |
| `management.*`       | the OSx-managing DAO + its multisig plugin instance |
| `ens.*`              | Aragon's ENS stack for this chain (registry, both subdomain registrars, resolver) |
| `plugins.<slug>`     | one entry per plugin (`admin`, `multisig`, `token-voting`, `spp`, `lock-to-vote`, `crosschain`) with `repo`, `ens`, `maintainer`, `versions[]`, optional `other{}` |
| `conditions.factories[]` | versioned condition factories on this chain |
| `deployers.*`        | one-shot deployment tools (e.g. `protocolFactory`) |

Addresses are lowercased on parse. Arrays are ascending; the highest
non-placeholder entry carries `current: true`. Plugin builds that point to the
OSx `PlaceholderSetup` carry `placeholder: true` (see the root README).

## Adding or updating a chain

See the [root README](../README.md) for `just ingest` (new chain from a
ProtocolFactory address) and the `just validate` / `just coverage` guardrails.
