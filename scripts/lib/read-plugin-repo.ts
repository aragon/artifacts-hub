import { createPublicClient, http, parseAbi, type Address } from "viem";

// Aragon PluginRepo exposes:
//   latestRelease() → uint8
//   buildCount(uint8 release) → uint256
//   getVersion(Tag) → Version { Tag(release, build), address pluginSetup, bytes buildMetadata }
// Each PluginSetup then has an `implementation()` getter returning the plugin impl.
const repoAbi = parseAbi([
  "function latestRelease() view returns (uint8)",
  "function buildCount(uint8 release) view returns (uint256)",
  "function getVersion((uint8 release, uint16 build) tag) view returns " +
    "(((uint8 release, uint16 build) tag, address pluginSetup, bytes buildMetadata))",
]);

const setupAbi = parseAbi([
  "function implementation() view returns (address)",
]);

export type OnChainVersion = {
  release: number;
  build: number;
  setup: Address;
  implementation?: Address;
  buildMetadata: string; // hex
};

// Enumerate every (release, build) that lives in a PluginRepo, newest last.
// Implementation address is best-effort: PluginRepo.getVersion doesn't return it,
// so we call setup.implementation() when the setup responds to it.
export async function readAllPluginRepoVersions(
  rpcUrl: string,
  repo: Address,
): Promise<OnChainVersion[]> {
  const client = createPublicClient({ transport: http(rpcUrl) });
  const latest = (await client.readContract({
    address: repo,
    abi: repoAbi,
    functionName: "latestRelease",
  })) as number;

  const versions: OnChainVersion[] = [];
  for (let r = 1; r <= latest; r++) {
    const buildCount = (await client.readContract({
      address: repo,
      abi: repoAbi,
      functionName: "buildCount",
      args: [r],
    })) as bigint;

    for (let b = 1; b <= Number(buildCount); b++) {
      const version = (await client.readContract({
        address: repo,
        abi: repoAbi,
        functionName: "getVersion",
        args: [{ release: r, build: b }],
      })) as {
        tag: { release: number; build: number };
        pluginSetup: Address;
        buildMetadata: string;
      };

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

      versions.push({
        release: version.tag.release,
        build: version.tag.build,
        setup: version.pluginSetup,
        implementation,
        buildMetadata: version.buildMetadata,
      });
    }
  }
  return versions;
}
