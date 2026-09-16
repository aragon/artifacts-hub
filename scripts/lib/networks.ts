// Read the just-foundry env files. These define which networks the hub cares
// about: the address SOURCES may cover more, but only chains listed here get
// a `addresses/<chainId>.json` written.

import { resolve } from "@std/path";

const REPO_ROOT = resolve(import.meta.dirname!, "..", "..", "..");
const NETWORKS_DIR = resolve(REPO_ROOT, "just-foundry", "networks");

export type NetworkEnv = {
  file: string;
  network: string;
  chainId: number;
  rpc: string;
};

export async function readAllNetworkEnvs(): Promise<NetworkEnv[]> {
  const out: NetworkEnv[] = [];
  for await (const entry of Deno.readDir(NETWORKS_DIR)) {
    if (!entry.isFile || !entry.name.endsWith(".env")) continue;
    const path = resolve(NETWORKS_DIR, entry.name);
    const kv = await parseEnvFile(path);
    if (!kv.CHAIN_ID || !kv.RPC_URL) continue;
    out.push({
      file: entry.name,
      network: kv.NETWORK_NAME || entry.name.replace(/\.env$/, ""),
      chainId: Number(kv.CHAIN_ID),
      rpc: kv.RPC_URL,
    });
  }
  return out.sort((a, b) => a.network.localeCompare(b.network));
}

async function parseEnvFile(path: string): Promise<Record<string, string>> {
  const kv: Record<string, string> = {};
  const text = await Deno.readTextFile(path);
  // Match: NAME=VALUE where VALUE is either "quoted" or a bare token.
  // Trailing comments (# …) after the value are tolerated.
  const re = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(?:"([^"]*)"|([^\s#]+))/;
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(re);
    if (m) kv[m[1]] = m[2] ?? m[3] ?? "";
  }
  return kv;
}
