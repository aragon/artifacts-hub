// Enumerate every (release, build) currently registered on a plugin's PluginRepo
// on-chain, and merge them into `addresses/<chainId>.json` under `plugins.<slug>`.
//
// Usage:
//   just refresh-plugin <slug> <chainId> <rpcUrl>
//   just refresh-plugin --dry-run <slug> <chainId> <rpcUrl>
//
// Behavior mirrors `just import-plugin`:
//   - Identity fields (repo/ens/maintainer) already present in the book are
//     preserved; the repo address must match `plugins.<slug>.repo` (that's
//     what we read versions from).
//   - Existing (release, build) with matching setup/implementation → no-op.
//   - Existing (release, build) with different addresses → hard error.
//   - New (release, build) → append, re-sort, re-stamp `current`.
//   - Deprecated chain → refused.
//   - Chain must be tracked and `plugins.<slug>.repo` must be set. Use
//     `just ingest` first if the chain is brand new; add the plugin entry
//     (repo + maintainer) via `just import-plugin` first if the plugin
//     isn't recorded yet.

import { resolve } from "@std/path";
import type { Address } from "viem";
import { AddressBook, type Plugin, firstZodError } from "./schema.ts";
import { mergePlugin, MergeError } from "./lib/merge-plugin.ts";
import { readAllPluginRepoVersions, toPluginVersion } from "./lib/read-plugin-repo.ts";
import { ensForSlug } from "./lib/plugin-catalog.ts";

const HERE = import.meta.dirname!;
const ADDRESSES_DIR = resolve(HERE, "..", "addresses");

class RefreshError extends Error {}

async function main() {
  const args = [...Deno.args];
  const dryRun = extractFlag(args, "--dry-run");
  if (args.length !== 3) {
    console.error("usage: just refresh-plugin [--dry-run] <slug> <chainId> <rpcUrl>");
    Deno.exit(2);
  }
  const [slug, chainIdStr, rpcUrl] = args;
  const chainId = Number(chainIdStr);
  if (!Number.isFinite(chainId) || chainId <= 0) {
    console.error(`invalid chainId: ${chainIdStr}`);
    Deno.exit(2);
  }

  const bookPath = resolve(ADDRESSES_DIR, `${chainId}.json`);
  let bookRaw: unknown;
  try {
    bookRaw = JSON.parse(await Deno.readTextFile(bookPath));
  } catch {
    console.error(`chain ${chainId} not tracked (no addresses/${chainId}.json). Run \`just ingest\` first.`);
    Deno.exit(1);
  }
  const parsed = AddressBook.safeParse(bookRaw);
  if (!parsed.success) {
    console.error(`existing addresses/${chainId}.json fails schema: ${firstZodError(parsed.error)}`);
    Deno.exit(1);
  }
  const book = parsed.data;

  if (book.deprecated) {
    console.error(`chain ${chainId} (${book.network}) is marked deprecated; refusing to refresh.`);
    Deno.exit(1);
  }

  const bookEntry = book.plugins[slug];
  if (!bookEntry?.repo) {
    console.error(
      `plugins.${slug}.repo is not set on ${book.network} (chainId ${chainId}). ` +
        `Add it first via \`just import-plugin\` or by hand.`,
    );
    Deno.exit(1);
  }
  const repo = bookEntry.repo as Address;

  try {
    const onchain = await readAllPluginRepoVersions(rpcUrl, repo);
    const incoming: Plugin = {
      repo,
      ens: bookEntry.ens ?? ensForSlug(slug),
      maintainer: bookEntry.maintainer,
      versions: onchain.map(toPluginVersion),
    };

    let summary: string;
    try {
      summary = mergePlugin(book, slug, incoming);
    } catch (e) {
      throw new RefreshError(e instanceof MergeError ? e.message : String(e));
    }

    const validated = AddressBook.parse(book);
    const label = `${book.network} (chainId ${chainId}) plugins.${slug} [${onchain.length} on-chain version${onchain.length === 1 ? "" : "s"}]`;
    if (dryRun) {
      console.log(`  ~ ${label}: ${summary}  (dry-run)`);
      return;
    }
    if (summary === "no-op") {
      console.log(`  · ${label}: no-op`);
      return;
    }
    await Deno.writeTextFile(bookPath, JSON.stringify(validated, null, 2) + "\n");
    console.log(`  ✓ ${label}: ${summary}`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`  ✗ ${book.network} (chainId ${chainId}) plugins.${slug}: ${msg}`);
    Deno.exit(1);
  }
}

function extractFlag(args: string[], flag: string): boolean {
  const i = args.indexOf(flag);
  if (i === -1) return false;
  args.splice(i, 1);
  return true;
}


await main();
