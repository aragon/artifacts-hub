// RPC endpoints per network, read from aragon/just-foundry's `networks/<network>.env`.
// just-foundry is cloned into a temp dir for the duration of the call: it is a
// source of RPC URLs, not a dependency of this repo.

import { join } from "@std/path";

const JUST_FOUNDRY = "https://github.com/aragon/just-foundry";

export type Network = { rpcUrl: string; chainId: number };

// Minimal dotenv: KEY="value" or KEY=value, `#` comments, blank lines.
export function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split("\n")) {
    const m = raw.match(/^\s*([A-Z0-9_]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s#]*))/);
    if (m) out[m[1]] = m[2] ?? m[3] ?? m[4];
  }
  return out;
}

// network name (env file basename) → endpoint. Files without RPC_URL or a
// numeric CHAIN_ID are skipped.
export async function loadNetworks(): Promise<Map<string, Network>> {
  const dir = await Deno.makeTempDir({ prefix: "artifacts-hub-just-foundry-" });
  try {
    const { code, stderr } = await new Deno.Command("git", {
      args: ["clone", "--quiet", "--depth", "1", JUST_FOUNDRY, dir],
      env: { GIT_TERMINAL_PROMPT: "0" },
      stdout: "null",
      stderr: "piped",
    }).output();
    if (code !== 0) throw new Error(`cloning ${JUST_FOUNDRY} failed: ${new TextDecoder().decode(stderr).trim()}`);
    const out = new Map<string, Network>();
    for await (const e of Deno.readDir(join(dir, "networks"))) {
      if (!e.isFile || !e.name.endsWith(".env")) continue;
      const env = parseEnv(await Deno.readTextFile(join(dir, "networks", e.name)));
      const chainId = Number(env.CHAIN_ID);
      if (env.RPC_URL && Number.isInteger(chainId) && chainId > 0) {
        out.set(e.name.slice(0, -4), { rpcUrl: env.RPC_URL, chainId });
      }
    }
    return out;
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
}
