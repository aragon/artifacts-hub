# abi

Aragon component ABIs: one JSON per contract, one folder per source component,
one subfolder per version.

## Naming

- `<component>/v<version>/<Contract>.json`: the raw ABI array at that version.
  Plugins use `v<release>.<build>` (as in `addresses/`), OSx its protocol
  version (`v1.4.0`). Bytecode intentionally omitted; consumers rely on the
  deployed on-chain code and pair with an address from [`../addresses`](../addresses).
- `<component>/v<version>/index.ts`: generated, exports each ABI as
  `export const <Contract>ABI = [...] as const;`. The `as const` gives viem
  the literal typing it needs for its `readContract` / `writeContract`
  type inference.
- `<component>/<Contract>.json` and `<component>/index.ts`: generated copies
  of (and a re-export from) the latest version folder, so unversioned paths
  always mean "latest".
- `index.ts`: top-level re-export: `export * as <ns> from "./<component>/index.ts";`
  (kebab-case slugs are re-exported as camelCase namespaces:
  `lock-to-vote` → `lockToVote`).
- [`sources.json`](./sources.json): where every version folder comes from
  (pinned git commit or npm package).

Each folder holds the component's public surface: deployable contracts, interfaces and libraries. Abstract base contracts are left out (their functions appear in the contracts that extend them).

Never edit generated files; edit `sources.json` and run `just import-abi`.

## Components

| slug                | source repo                                     |
|---------------------|-------------------------------------------------|
| `osx`               | `aragon/osx`                                    |
| `admin`             | `aragon/admin-plugin`                           |
| `multisig`          | `aragon/multisig-plugin`                        |
| `token-voting`      | `aragon/token-voting-plugin`                    |
| `spp`               | `aragon/staged-proposal-processor-plugin`       |
| `lock-to-vote`      | `aragon/lock-to-vote-plugin`                    |
| `crosschain`        | `aragon/crosschain`                             |
| `conditions`        | `aragon/condition-library`                      |
| `protocol-factory`  | `aragon/protocol-factory`                       |

Builds before the plugin repos split out of `aragon/osx` (admin 1.1,
multisig 1.1 and 1.2, token-voting 1.1 and 1.2) come from the legacy
`@aragon/osx-ethers` npm packages.

## Consuming

```ts
// tight-typed viem imports (recommended), latest version
import { AdminABI, AdminSetupABI } from "./lib/artifacts-hub/abi/admin";

// a specific version, e.g. the build a DAO still runs
import { MultisigABI } from "./lib/artifacts-hub/abi/multisig/v1.2";

// or grab everything under a namespace
import { admin, tokenVoting } from "./lib/artifacts-hub/abi";
admin.AdminABI;
tokenVoting.TokenVotingABI;

// or plain JSON if `resolveJsonModule` is on and you don't need `as const`
import Admin from "./lib/artifacts-hub/abi/admin/Admin.json";
```

## Updating

See "Refreshing ABIs" in the [root README](../README.md#refreshing-abis):
`just import-abi`, `just verify-abi`, `just generate-abi [--check]`.
