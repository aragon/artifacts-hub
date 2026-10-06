import { assertEquals } from "@std/assert";
import { parseEnv } from "../lib/networks.ts";

Deno.test("parseEnv reads the just-foundry networks/*.env shape", () => {
  const env = parseEnv([
    `RPC_URL="https://arbitrum.drpc.org"    # public fallback; override via vars`,
    `CHAIN_ID="42161"`,
    `# alternative`,
    `BLOCKSCOUT_HOST_NAME=eth.blockscout.com # trailing comment`,
    ``,
    `SINGLE='quoted value'`,
    `EMPTY=""`,
    `lowercase=ignored`,
    `  INDENTED = "spaced"`,
  ].join("\n"));
  assertEquals(env, {
    RPC_URL: "https://arbitrum.drpc.org",
    CHAIN_ID: "42161",
    BLOCKSCOUT_HOST_NAME: "eth.blockscout.com",
    SINGLE: "quoted value",
    EMPTY: "",
    INDENTED: "spaced",
  });
});

Deno.test("parseEnv keeps a # inside quotes", () => {
  assertEquals(parseEnv(`RPC_URL="https://x.io/#frag"`).RPC_URL, "https://x.io/#frag");
});
