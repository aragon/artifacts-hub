import {
  createPublicClient,
  http,
  namehash,
  parseAbi,
  type Address,
  type Hex,
} from "viem";

const registryAbi = parseAbi([
  "function resolver(bytes32 node) view returns (address)",
]);
const resolverAbi = parseAbi([
  "function addr(bytes32 node) view returns (address)",
]);

const ZERO = "0x0000000000000000000000000000000000000000";

// Resolve an ENS name against a specific registry. Returns the address stored
// under the name's resolver, or undefined if the name isn't set up.
export async function resolveEns(
  rpcUrl: string,
  registry: Address,
  name: string,
): Promise<Address | undefined> {
  const client = createPublicClient({ transport: http(rpcUrl) });
  const node = namehash(name) as Hex;

  const resolver = (await client.readContract({
    address: registry,
    abi: registryAbi,
    functionName: "resolver",
    args: [node],
  })) as Address;
  if (resolver.toLowerCase() === ZERO) return undefined;

  const addr = (await client.readContract({
    address: resolver,
    abi: resolverAbi,
    functionName: "addr",
    args: [node],
  })) as Address;
  return addr.toLowerCase() === ZERO ? undefined : addr;
}
