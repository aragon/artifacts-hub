import {
  createPublicClient,
  decodeAbiParameters,
  http,
  parseAbi,
  parseAbiParameters,
  toFunctionSelector,
  type Address,
} from "viem";

// ProtocolFactory.getDeployment() returns one packed struct of addresses. The
// struct has grown over time: older factories return 17 fields, newer ones
// return 18 (they added lockToVotePluginRepo). We decode raw eth_call output
// and pick the shape by returned length so old and new deployments both work.
//
// See protocol-factory/src/ProtocolFactory.sol → `struct Deployment`.

const V1_FIELDS = [
  // OSx static
  "daoFactory", "pluginRepoFactory", "pluginSetupProcessor",
  "globalExecutor", "placeholderSetup",
  // OSx proxies
  "daoRegistry", "pluginRepoRegistry",
  "managementDao", "managementDaoMultisig",
  // ENS
  "ensRegistry", "daoSubdomainRegistrar", "pluginSubdomainRegistrar", "publicResolver",
  // Plugin repos (v1 has 4)
  "adminPluginRepo", "multisigPluginRepo",
  "tokenVotingPluginRepo", "stagedProposalProcessorPluginRepo",
] as const;

const V2_FIELDS = [...V1_FIELDS, "lockToVotePluginRepo"] as const;

// Deployment type is the union — every field optional. Old factories won't
// populate lockToVotePluginRepo; treat its absence as "resolve elsewhere" (ENS).
export type Deployment = Partial<Record<(typeof V2_FIELDS)[number], Address>>;

const SELECTOR = toFunctionSelector("getDeployment()");

export async function readProtocolFactory(
  rpcUrl: string,
  factory: Address,
): Promise<Deployment> {
  const client = createPublicClient({ transport: http(rpcUrl) });
  const { data } = await client.call({ to: factory, data: SELECTOR });
  if (!data) throw new Error(`getDeployment() returned empty data`);

  const bytes = (data.length - 2) / 2; // strip 0x prefix, count bytes
  const fields = bytes >= V2_FIELDS.length * 32 ? V2_FIELDS : V1_FIELDS;
  const params = parseAbiParameters(fields.map(() => "address").join(", "));
  const decoded = decodeAbiParameters(params, data) as readonly Address[];

  const result: Deployment = {};
  fields.forEach((name, i) => {
    result[name] = decoded[i];
  });
  return result;
}

// Small helper: return "major.minor.patch" from any contract exposing
// protocolVersion() → (uint8,uint8,uint8). DAOFactory does; DAO does.
export async function readProtocolVersion(
  rpcUrl: string,
  target: Address,
): Promise<string> {
  const client = createPublicClient({ transport: http(rpcUrl) });
  const [major, minor, patch] = (await client.readContract({
    address: target,
    abi: parseAbi([
      "function protocolVersion() view returns (uint8, uint8, uint8)",
    ]),
    functionName: "protocolVersion",
  })) as unknown as [number, number, number];
  return `${major}.${minor}.${patch}`;
}
