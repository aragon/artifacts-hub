// Turns an `abi/sources.json` entry into a set of ABIs.
//
//   npm:<pkg>@<ver>  Deno imports the package directly (dependencies included)
//                    and reads its exported ABIs.
//   git:<url>#<sha>  Fresh clone in a temp dir, `forge build`, then every
//                    non-abstract contract, interface and library declared
//                    under `src/`. The temp dir is removed afterwards.
//
// Private repos: anything not reachable over HTTPS (the repo itself or one of
// its submodules) is cloned from the sibling checkout `../<repo>` next to this
// repo instead. Nested submodules of a private submodule must be public.

import { basename, join, resolve } from "@std/path";
import { walk } from "@std/fs";
import { type AbiSet, abiEqual, abiFromForgeArtifact, abisFromModule, pickContracts } from "./abi.ts";
import type { AbiSource } from "../schema.ts";

const HUB_ROOT = resolve(import.meta.dirname!, "..", "..");

export async function fetchAbis(entry: AbiSource): Promise<AbiSet> {
  const [kind, spec] = [entry.source.slice(0, 3), entry.source.slice(4)];
  const all = kind === "npm" ? await fromNpm(spec) : await fromGit(spec);
  return pickContracts(all, entry.contracts);
}

async function fromNpm(spec: string): Promise<AbiSet> {
  const mod = await import(`npm:${spec}`);
  // CJS bundles land under `default` when imported as ESM.
  const set = abisFromModule({ ...(mod.default ?? {}), ...mod });
  if (!set.size) throw new Error(`npm:${spec} exports no ABIs`);
  return set;
}

async function fromGit(spec: string): Promise<AbiSet> {
  const [url, sha] = spec.split("#");
  const dir = await Deno.makeTempDir({ prefix: "artifacts-hub-abi-" });
  try {
    const origin = await cloneUrl(url);
    await git(["clone", "--quiet", origin, dir]);
    if ((await git(["-C", dir, "checkout", "--quiet", "--detach", sha], true)) === undefined) {
      throw new Error(`${origin} has no commit ${sha}${origin === url ? "" : " (git fetch in that checkout)"}`);
    }
    // Point unreachable (private) submodules at their sibling checkout.
    await git(["-C", dir, "submodule", "init", "--quiet"]);
    const urls = (await git(["-C", dir, "config", "--get-regexp", "^submodule\\..*\\.url$"], true)) ?? "";
    for (const line of urls.split("\n").filter(Boolean)) {
      const [key, subUrl] = line.split(" ");
      const resolved = await cloneUrl(subUrl);
      if (resolved !== subUrl) await git(["-C", dir, "config", key, resolved]);
    }
    await git(["-c", "protocol.file.allow=always", "-C", dir, "submodule", "update", "--quiet", "--init", "--recursive"]);
    await run(["forge", "build", "--quiet", "--ast", "--skip", "test", "--skip", "script"], dir);
    return await readForgeOut(join(dir, "out"));
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
}

// `url` when it answers over HTTPS without credentials, else the sibling checkout.
const reachable = new Map<string, Promise<string>>();
function cloneUrl(url: string): Promise<string> {
  if (!reachable.has(url)) {
    reachable.set(url, (async () => {
      if ((await git(["ls-remote", "--quiet", url, "HEAD"], true)) !== undefined) return url;
      const sibling = resolve(HUB_ROOT, "..", basename(url).replace(/\.git$/, ""));
      if ((await git(["-C", sibling, "rev-parse", "--git-dir"], true)) !== undefined) return sibling;
      throw new Error(`${url} is not reachable over HTTPS and there is no checkout at ${sibling}`);
    })());
  }
  return reachable.get(url)!;
}

async function readForgeOut(outDir: string): Promise<AbiSet> {
  const set: AbiSet = new Map();
  for await (const f of walk(outDir, { exts: [".json"], includeDirs: false })) {
    if (f.path.includes("/build-info/")) continue;
    const found = abiFromForgeArtifact(JSON.parse(await Deno.readTextFile(f.path)));
    if (!found) continue;
    const prev = set.get(found.name);
    if (prev && !abiEqual(prev, found.abi)) {
      throw new Error(`two different contracts named ${found.name} under src/`);
    }
    set.set(found.name, found.abi);
  }
  if (!set.size) throw new Error(`forge build produced no ABIs under src/`);
  return set;
}

function git(args: string[], allowFail = false): Promise<string | undefined> {
  return run(["git", ...args], undefined, allowFail);
}

// stdout on success; undefined on failure when `allowFail`, else throws with stderr.
async function run(cmd: string[], cwd?: string, allowFail = false): Promise<string | undefined> {
  const { code, stdout, stderr } = await new Deno.Command(cmd[0], {
    args: cmd.slice(1),
    cwd,
    env: { GIT_TERMINAL_PROMPT: "0" }, // never hang on a credentials prompt
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (code === 0) return new TextDecoder().decode(stdout);
  if (allowFail) return undefined;
  throw new Error(`\`${cmd.join(" ")}\` failed:\n${new TextDecoder().decode(stderr).trim()}`);
}
