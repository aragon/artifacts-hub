// Merge one or more `PluginArtifact` envelopes (as emitted by a plugin repo's
// deploy script into `<plugin>/artifacts/artifacts-<network>-<timestamp>.json`)
// into `addresses/<chainId>.json` under `plugins.<slug>`.
//
// Usage:
//   just import-plugin <path>            # file OR directory (sweeps *.json in ts-ascending order)
//   just import-plugin --dry-run <path>  # print planned merges, don't write
//
// Invariants enforced (see README > "Ingesting plugin deployments"):
//   - Identity fields (repo / ens / maintainer) are per-chain constants: any
//     mismatch against an existing entry is a hard error.
//   - Versions are additive. Same (release, build) with same (setup, impl,
//     other) is a no-op; different addresses is a hard error.
//   - `current: true` is derived: after merge, only the highest (release,
//     build) carries it.
//   - Chain must be tracked (addresses/<chainId>.json must exist) and NOT
//     marked `deprecated: true`.
//   - Final book must Zod-validate before writing; addresses are stored
//     lowercased (schema does the transform).

import { resolve } from "@std/path";
import { AddressBook, PluginArtifact } from "./schema.ts";
import { mergePlugin, MergeError } from "./lib/merge-plugin.ts";

const HERE = import.meta.dirname!;
const ADDRESSES_DIR = resolve(HERE, "..", "addresses");

class ImportError extends Error {}

// ---------------------------------------------------------------------------

async function main() {
  const args = [...Deno.args];
  const dryRun = extractFlag(args, "--dry-run");
  if (args.length !== 1) {
    console.error("usage: just import-plugin [--dry-run] <path>");
    Deno.exit(2);
  }
  const target = resolve(Deno.env.get("INVOCATION_DIR") ?? Deno.cwd(), args[0]);
  const artifacts = await enumerateArtifacts(target);
  if (!artifacts.length) {
    console.error(`no artifact JSON files found at ${target}`);
    Deno.exit(2);
  }

  let errors = 0;
  for (const path of artifacts) {
    try {
      await importOne(path, dryRun);
    } catch (e) {
      errors++;
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`  ✗ ${relDisplay(path)}: ${msg}`);
    }
  }
  if (errors) Deno.exit(1);
}

function extractFlag(args: string[], flag: string): boolean {
  const i = args.indexOf(flag);
  if (i === -1) return false;
  args.splice(i, 1);
  return true;
}

async function enumerateArtifacts(path: string): Promise<string[]> {
  let stat: Deno.FileInfo;
  try { stat = await Deno.stat(path); } catch { return []; }
  if (stat.isFile) return [path];
  if (!stat.isDirectory) return [];
  const entries: { path: string; ts: number }[] = [];
  for await (const e of Deno.readDir(path)) {
    if (!e.isFile || !e.name.endsWith(".json")) continue;
    const p = resolve(path, e.name);
    try {
      const raw = JSON.parse(await Deno.readTextFile(p));
      const ts = typeof raw?.timestamp === "number" ? raw.timestamp : 0;
      entries.push({ path: p, ts });
    } catch {
      // Non-parseable JSONs error out during importOne — surface then.
      entries.push({ path: p, ts: 0 });
    }
  }
  // Ascending timestamp so that repeated `(release, build)` entries no-op after
  // the first, and any genuinely new version lands after its predecessors.
  entries.sort((a, b) => a.ts - b.ts);
  return entries.map((e) => e.path);
}

async function importOne(artifactPath: string, dryRun: boolean): Promise<void> {
  const raw = await readJson(artifactPath);
  const parsed = PluginArtifact.safeParse(raw);
  if (!parsed.success) {
    throw new ImportError(`invalid PluginArtifact: ${firstZodError(parsed.error)}`);
  }
  const art = parsed.data;

  const bookPath = resolve(ADDRESSES_DIR, `${art.chainId}.json`);
  let bookRaw: unknown;
  try {
    bookRaw = await readJson(bookPath);
  } catch {
    throw new ImportError(
      `chain ${art.chainId} not tracked (no addresses/${art.chainId}.json). Run \`just ingest\` first.`,
    );
  }
  const bookParsed = AddressBook.safeParse(bookRaw);
  if (!bookParsed.success) {
    throw new ImportError(`existing addresses/${art.chainId}.json fails schema: ${firstZodError(bookParsed.error)}`);
  }
  const book = bookParsed.data;

  if (book.deprecated) {
    throw new ImportError(`chain ${art.chainId} (${book.network}) is marked deprecated; refusing to import.`);
  }
  if (book.chainId !== art.chainId || book.network !== art.network) {
    throw new ImportError(
      `chain identity mismatch: artifact says ${art.chainId}/${art.network}, book says ${book.chainId}/${book.network}`,
    );
  }

  let summary: string;
  try {
    summary = mergePlugin(book, art.slug, art.plugin);
  } catch (e) {
    throw new ImportError(e instanceof MergeError ? e.message : String(e));
  }

  // Round-trip through Zod so addresses land canonically lowercased.
  const validated = AddressBook.parse(book);
  if (dryRun) {
    console.log(`  ~ ${relDisplay(artifactPath)} → plugins.${art.slug}: ${summary}  (dry-run)`);
    return;
  }
  if (summary === "no-op") {
    console.log(`  · ${relDisplay(artifactPath)} → plugins.${art.slug}: no-op`);
    return;
  }
  await Deno.writeTextFile(bookPath, JSON.stringify(validated, null, 2) + "\n");
  console.log(`  ✓ ${relDisplay(artifactPath)} → plugins.${art.slug}: ${summary}`);
}

// ---------------------------------------------------------------------------

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await Deno.readTextFile(path));
}

function firstZodError(err: { issues: { path: (string | number)[]; message: string }[] }): string {
  const i = err.issues[0];
  if (!i) return "unknown parse error";
  const p = i.path.length ? i.path.join(".") : "(root)";
  return `${p}: ${i.message}`;
}

function relDisplay(p: string): string {
  const cwd = Deno.cwd();
  return p.startsWith(cwd) ? p.slice(cwd.length + 1) : p;
}

await main();
