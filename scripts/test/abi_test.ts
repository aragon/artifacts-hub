import { assertEquals, assertThrows } from "@std/assert";
import {
  abiEqual,
  abiFromForgeArtifact,
  abisFromModule,
  compareVersions,
  isVersionDir,
  latestVersion,
  missingSelectors,
  pickContracts,
  planMerge,
} from "../lib/abi.ts";

const transfer = {
  type: "function",
  name: "transfer",
  inputs: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }],
  outputs: [{ name: "", type: "bool" }],
  stateMutability: "nonpayable",
};
const approve = { ...transfer, name: "approve" };
const event = { type: "event", name: "Transfer", inputs: [], anonymous: false };

Deno.test("isVersionDir accepts only v<n>.<n>[.<n>…]", () => {
  for (const ok of ["v1.2", "v1.4.0", "v10.20.30"]) assertEquals(isVersionDir(ok), true, ok);
  for (const bad of ["v1", "1.2", "v1.2-rc", "V1.2", "v1.", "index.ts", "v1.x"]) assertEquals(isVersionDir(bad), false, bad);
});

Deno.test("compareVersions is numeric per segment, not lexicographic", () => {
  assertEquals(compareVersions("v1.10", "v1.9") > 0, true);
  assertEquals(compareVersions("v2.0", "v1.99") > 0, true);
  assertEquals(compareVersions("v1.4.0", "v1.4") > 0, true);
  assertEquals(compareVersions("v1.3", "v1.3"), 0);
});

Deno.test("latestVersion ignores non-version names and handles none", () => {
  assertEquals(latestVersion(["v1.9", "v1.10", "v1.2", "latest", "v9"]), "v1.10");
  assertEquals(latestVersion(["index.ts"]), undefined);
  assertEquals(latestVersion([]), undefined);
});

Deno.test("abiEqual ignores entry order and key order", () => {
  const reordered = Object.fromEntries(Object.entries(transfer).reverse());
  assertEquals(abiEqual([transfer, event], [event, reordered]), true);
});

Deno.test("abiEqual sees signature and mutability changes", () => {
  const widened = { ...transfer, inputs: [transfer.inputs[0], { name: "amount", type: "uint128" }] };
  assertEquals(abiEqual([transfer], [widened]), false);
  // Real case: LockToVotePluginSetup.prepareUpdate went from pure to nonpayable.
  assertEquals(abiEqual([transfer], [{ ...transfer, stateMutability: "pure" }]), false);
  assertEquals(abiEqual([transfer], [transfer, event]), false);
  // Same length, one duplicated entry vs two distinct ones.
  assertEquals(abiEqual([transfer, transfer], [transfer, approve]), false);
});

Deno.test("planMerge: additive folders, conflicts never overwrite", () => {
  const existing = new Map([["A", [transfer]], ["B", [transfer]], ["Gone", [event]]]);
  const incoming = new Map([["A", [transfer]], ["B", [approve]], ["New", [event]]]);
  assertEquals(planMerge(existing, incoming), {
    added: ["New"],
    unchanged: ["A"],
    conflicts: ["B"],
    notInSource: ["Gone"],
  });
  assertEquals(planMerge(new Map(), incoming).added, ["B", "A", "New"].sort());
});

Deno.test("abisFromModule reads <Name>ABI exports and TypeChain factories", () => {
  const set = abisFromModule({
    TokenABI: [transfer],
    Admin__factory: { abi: [approve] },
    EmptyABI: [],
    NotAnABI: "string export ending in ABI is ignored",
    activeContractsList: { mainnet: {} },
    Broken__factory: { abi: "nope" },
    FooABI: "not an array",
  });
  assertEquals([...set.keys()].sort(), ["Admin", "Token"]);
  assertEquals(set.get("Admin"), [approve]);
});

Deno.test("abisFromModule copies, so writes can't mutate the imported module", () => {
  const mod = { TokenABI: [{ ...transfer }] };
  (abisFromModule(mod).get("Token")![0] as Record<string, unknown>).name = "changed";
  assertEquals(mod.TokenABI[0].name, "transfer");
});

Deno.test("abiFromForgeArtifact keeps src/ contracts, interfaces and libraries with a non-empty ABI", () => {
  const art = (path: string, name: string, abi: unknown[], kind = "contract", abstract = false) => ({
    abi,
    metadata: { settings: { compilationTarget: { [path]: name } } },
    // Other definitions in the same file (e.g. a helper interface) must not be mistaken for the target.
    ast: { nodes: [{ nodeType: "ContractDefinition", name: "Other", abstract: true }, { nodeType: "ContractDefinition", name, contractKind: kind, abstract }] },
  });
  // Name comes from the compilation target, not the file name (`DAO.0.8.17.json`).
  assertEquals(abiFromForgeArtifact(art("src/core/dao/DAO.sol", "DAO", [transfer])), { name: "DAO", abi: [transfer] });
  assertEquals(abiFromForgeArtifact(art("src/ILockManager.sol", "ILockManager", [transfer], "interface"))?.name, "ILockManager");
  assertEquals(abiFromForgeArtifact(art("src/Errors.sol", "Errors", [event], "library"))?.name, "Errors");
  assertEquals(abiFromForgeArtifact(art("lib/forge-std/src/Test.sol", "Test", [transfer])), undefined);
  assertEquals(abiFromForgeArtifact(art("test/Mock.sol", "Mock", [transfer])), undefined);
  assertEquals(abiFromForgeArtifact(art("src/auth.sol", "auth", [])), undefined);
  assertEquals(abiFromForgeArtifact({ abi: [transfer] }), undefined);
  assertEquals(abiFromForgeArtifact(art("srcx/Evil.sol", "Evil", [transfer])), undefined);
});

Deno.test("abiFromForgeArtifact skips abstract contracts", () => {
  const abstractBase = {
    abi: [transfer],
    metadata: { settings: { compilationTarget: { "src/lib/PluginUUPSUpgradeable.sol": "PluginUUPSUpgradeable" } } },
    ast: { nodes: [{ nodeType: "ContractDefinition", name: "PluginUUPSUpgradeable", contractKind: "contract", abstract: true }] },
  };
  assertEquals(abiFromForgeArtifact(abstractBase), undefined);
});

Deno.test("abiFromForgeArtifact refuses an artifact built without --ast", () => {
  const noAst = { abi: [transfer], metadata: { settings: { compilationTarget: { "src/A.sol": "A" } } } };
  assertThrows(() => abiFromForgeArtifact(noAst), Error, "forge build --ast");
});

Deno.test("pickContracts narrows, and fails loudly on a missing name", () => {
  const set = new Map([["A", [transfer]], ["B", [approve]]]);
  assertEquals([...pickContracts(set, ["B"]).keys()], ["B"]);
  assertEquals(pickContracts(set, undefined), set);
  assertThrows(() => pickContracts(set, ["A", "Typo"]), Error, "Typo");
});

Deno.test("missingSelectors checks functions only, case- and prefix-insensitive", () => {
  // transfer(address,uint256) = 0xa9059cbb, approve(address,uint256) = 0x095ea7b3
  const code = "0x6080604052" + "A9059CBB" + "deadbeef";
  assertEquals(missingSelectors([transfer, event], code), []);
  assertEquals(missingSelectors([transfer, approve], code), ["approve (0x095ea7b3)"]);
  assertEquals(missingSelectors([transfer], "6080a9059cbb"), []);
  assertEquals(missingSelectors([transfer], "0x"), ["transfer (0xa9059cbb)"]);
});
