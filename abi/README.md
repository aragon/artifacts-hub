# abi

Aragon component ABIs — one JSON per contract, one folder per source component.

## Naming

- `<component>/<Contract>.json` — the raw ABI array. Bytecode intentionally
  omitted; consumers rely on the deployed on-chain code and pair with an
  address from [`../addresses`](../addresses).
- `<component>/index.ts` — a generated file exporting each ABI as
  `export const <Contract>ABI = [...] as const;`. The `as const` gives viem
  the literal typing it needs for its `readContract` / `writeContract`
  type inference.
- `index.ts` — top-level re-export: `export * as <ns> from "./<component>";`
  (kebab-case slugs are re-exported as camelCase namespaces —
  `lock-to-vote` → `lockToVote`).

## Components

| slug            | source repo                                     |
|-----------------|-------------------------------------------------|
| `osx`           | `aragon/osx`                                    |
| `admin`         | `aragon/admin-plugin`                           |
| `multisig`      | `aragon/multisig-plugin`                        |
| `token-voting`  | `aragon/token-voting-plugin`                    |
| `spp`           | `aragon/staged-proposal-processor-plugin`       |
| `lock-to-vote`  | `aragon/lock-to-vote-plugin`                    |
| `conditions`    | `aragon/condition-library`                      |

## Consuming

```ts
// tight-typed viem imports (recommended)
import { AdminABI, AdminSetupABI } from "./lib/artifacts-hub/abi/admin";

// or grab everything under a namespace
import { admin, tokenVoting } from "./lib/artifacts-hub/abi";
admin.AdminABI;
tokenVoting.TokenVotingABI;

// or plain JSON if `resolveJsonModule` is on and you don't need `as const`
import Admin from "./lib/artifacts-hub/abi/admin/Admin.json";
```

## Regenerating

`just generate-abi` regenerates `abi/**/index.ts` from whatever JSONs are on
disk. Run it after any hand-edit or fresh drop of an ABI JSON.
