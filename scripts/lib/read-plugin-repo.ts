import {
  type Address,
  BaseError,
  createPublicClient,
  encodeFunctionData,
  HttpRequestError,
  http,
  parseAbi,
  type PublicClient,
  TimeoutError,
  toFunctionSelector,
} from "viem";
import type { PluginVersion } from "../schema.ts";

// Aragon PluginRepo exposes:
//   latestRelease() → uint8
//   buildCount(uint8 release) → uint256
//   getVersion(Tag) → Version { Tag(release, build), address pluginSetup, bytes buildMetadata }
// Each PluginSetup then has an `implementation()` getter returning the plugin impl.
// Split into single-function abis so viem's per-call type narrowing works cleanly.
const latestReleaseAbi = parseAbi(["function latestRelease() view returns (uint8)"]);
const buildCountAbi = parseAbi(["function buildCount(uint8 release) view returns (uint256)"]);
const getVersionAbi = parseAbi([
  "function getVersion((uint8 release, uint16 build) tag) view returns (((uint8 release, uint16 build) tag, address pluginSetup, bytes buildMetadata))",
]);
const setupAbi = parseAbi(["function implementation() view returns (address)"]);
const prepareInstallationAbi = parseAbi(["function prepareInstallation(address dao, bytes data)"]);

// OSx PlaceholderSetup (every version since 1.3) reverts any installation with
// this error, whatever the arguments. A real setup never does.
export const PLACEHOLDER_ERROR = toFunctionSelector("PlaceholderSetupCannotBeUsed()");

export type OnChainVersion = {
  release: number;
  build: number;
  setup: Address;
  implementation?: Address; // absent when implementation() is missing or returns 0x0
  placeholder: boolean;
  buildMetadata: string; // hex
};

// The book entry for an on-chain version (`current` is stamped by the caller).
export function toPluginVersion(v: OnChainVersion): PluginVersion {
  return {
    release: v.release,
    build: v.build,
    setup: v.setup,
    ...(v.implementation ? { implementation: v.implementation } : {}),
    ...(v.placeholder ? { placeholder: true as const } : {}),
  };
}

// True when the revert error (from any RPC provider) carries PlaceholderSetupCannotBeUsed().
// Providers put the revert data in different places (data field, nested cause,
// message text), so the whole error chain is searched for the selector.
export function isPlaceholderRevert(err: unknown): boolean {
  const seen: string[] = [];
  let e: unknown = err;
  for (let depth = 0; e && depth < 10; depth++) {
    const o = e as { data?: unknown; message?: unknown; details?: unknown; cause?: unknown };
    for (const v of [o.data, o.message, o.details]) if (typeof v === "string") seen.push(v.toLowerCase());
    if (o.data && typeof o.data === "object") seen.push(JSON.stringify(o.data).toLowerCase());
    e = o.cause;
  }
  return seen.some((s) => s.includes(PLACEHOLDER_ERROR.slice(2)));
}

async function isPlaceholder(client: PublicClient, setup: Address): Promise<boolean> {
  try {
    await client.call({
      to: setup,
      data: encodeFunctionData({
        abi: prepareInstallationAbi,
        functionName: "prepareInstallation",
        args: ["0x0000000000000000000000000000000000000001", "0x"],
      }),
    });
    return false;
  } catch (e) {
    // A transport failure says nothing about the setup: surface it rather than
    // recording a guess.
    if (e instanceof BaseError && e.walk((x) => x instanceof HttpRequestError || x instanceof TimeoutError)) throw e;
    return isPlaceholderRevert(e);
  }
}

// Enumerate every (release, build) that lives in a PluginRepo, newest last.
// Implementation address is best-effort: PluginRepo.getVersion doesn't return it,
// so we call setup.implementation() when the setup responds to it.
export async function readAllPluginRepoVersions(
  rpcUrl: string,
  repo: Address,
): Promise<OnChainVersion[]> {
  const client = createPublicClient({ transport: http(rpcUrl) }) as PublicClient;
  const latest = await client.readContract({
    address: repo, abi: latestReleaseAbi, functionName: "latestRelease",
  });

  const versions: OnChainVersion[] = [];
  for (let r = 1; r <= latest; r++) {
    const buildCount = await client.readContract({
      address: repo, abi: buildCountAbi, functionName: "buildCount", args: [r],
    });

    for (let b = 1; b <= Number(buildCount); b++) {
      const version = await client.readContract({
        address: repo, abi: getVersionAbi, functionName: "getVersion",
        args: [{ release: r, build: b }],
      });

      // Best-effort: implementation() only exists on PluginSetups that expose
      // a distinct impl. Missing here just means we won't populate the field.
      let implementation: Address | undefined;
      try {
        implementation = (await client.readContract({
          address: version.pluginSetup,
          abi: setupAbi,
          functionName: "implementation",
        })) as Address;
      } catch {
        implementation = undefined;
      }
      if (implementation && /^0x0{40}$/i.test(implementation)) implementation = undefined;

      versions.push({
        release: version.tag.release,
        build: version.tag.build,
        setup: version.pluginSetup,
        implementation,
        placeholder: await isPlaceholder(client, version.pluginSetup),
        buildMetadata: version.buildMetadata,
      });
    }
  }
  return versions;
}
