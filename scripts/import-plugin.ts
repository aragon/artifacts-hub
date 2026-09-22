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
import { AddressBook, PluginArtifact, type Plugin, type PluginVersion } from "./schema.ts";

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

  const summary = mergePlugin(book, art.slug, art.plugin);

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

// Mutates `book.plugins[slug]` in place; returns a human summary of what
// changed. Throws ImportError on any invariant violation.
function mergePlugin(
  book: { plugins: Record<string, Plugin> },
  slug: string,
  incoming: Plugin,
): string {
  const existing = book.plugins[slug];

  if (!existing) {
    // Fresh entry: adopt identity + versions verbatim, then normalise the
    // current flag (only the last version in sorted order carries it).
    const versions = sortVersions([...incoming.versions]);
    stampCurrent(versions);
    book.plugins[slug] = {
      repo: incoming.repo,
      ens: incoming.ens,
      maintainer: incoming.maintainer,
      versions,
      ...(incoming.other ? { other: { ...incoming.other } } : {}),
    };
    return versions.length
      ? `created (repo ${short(incoming.repo)}, ${versions.length} version${versions.length === 1 ? "" : "s"})`
      : `created (repo ${short(incoming.repo)}, no versions)`;
  }

  // Identity fields are per-chain constants. Any mismatch is a hard error.
  const eq = (a?: string, b?: string) => (a ?? "").toLowerCase() === (b ?? "").toLowerCase();
  if (!eq(existing.repo, incoming.repo)) {
    throw new ImportError(
      `repo mismatch on plugins.${slug}: book=${existing.repo}, artifact=${incoming.repo}`,
    );
  }
  if (existing.ens && incoming.ens && existing.ens !== incoming.ens) {
    throw new ImportError(
      `ens mismatch on plugins.${slug}: book=${existing.ens}, artifact=${incoming.ens}`,
    );
  }
  if (existing.maintainer && incoming.maintainer && !eq(existing.maintainer, incoming.maintainer)) {
    throw new ImportError(
      `maintainer mismatch on plugins.${slug}: book=${existing.maintainer}, artifact=${incoming.maintainer}` +
        ` (ownership transfers should land as a reviewed PR, not through import)`,
    );
  }

  // Merge plugin-scoped `other` additively.
  const otherChanges = mergeOther(existing, incoming, `plugins.${slug}.other`);

  // Merge versions.
  const perVersion: string[] = [];
  for (const v of incoming.versions) {
    perVersion.push(mergeVersion(existing, v, slug));
  }

  const added = perVersion.filter((s) => s === "added").length;
  const noop = perVersion.filter((s) => s === "noop").length;
  const otherAdded = otherChanges.filter((s) => s === "added").length;

  // Re-sort and re-stamp `current` after any structural change.
  if (added > 0) {
    existing.versions = sortVersions(existing.versions);
    stampCurrent(existing.versions);
  }

  const parts: string[] = [];
  if (added) parts.push(`added ${added} version${added === 1 ? "" : "s"}`);
  if (noop) parts.push(`${noop} no-op`);
  if (otherAdded) parts.push(`+${otherAdded} auxiliary`);
  return parts.length ? parts.join(", ") : "no-op";
}

// Handles a single incoming PluginVersion against `existing.versions`.
// Returns "added" or "noop"; throws ImportError on a (release, build)
// collision with differing addresses.
function mergeVersion(existing: Plugin, incoming: PluginVersion, slug: string): "added" | "noop" {
  const match = existing.versions.find(
    (v) => v.release === incoming.release && v.build === incoming.build,
  );
  if (!match) {
    // Strip `current`; we recompute across the whole array after the loop.
    const { current: _drop, ...clean } = incoming;
    existing.versions.push(clean);
    return "added";
  }
  // Same (release, build) — enforce address identity.
  const eqAddr = (a?: string, b?: string) => (a ?? "").toLowerCase() === (b ?? "").toLowerCase();
  if (!eqAddr(match.setup, incoming.setup)) {
    throw new ImportError(
      `version ${incoming.release}.${incoming.build} on plugins.${slug}: setup mismatch (book=${match.setup}, artifact=${incoming.setup})`,
    );
  }
  if (match.implementation && incoming.implementation && !eqAddr(match.implementation, incoming.implementation)) {
    throw new ImportError(
      `version ${incoming.release}.${incoming.build} on plugins.${slug}: implementation mismatch (book=${match.implementation}, artifact=${incoming.implementation})`,
    );
  }
  // Also enforce per-version `other` matches; new keys may be added by re-runs
  // that record more auxiliary addresses, but existing keys can't change.
  if (incoming.other) {
    match.other ??= {};
    for (const [k, v] of Object.entries(incoming.other)) {
      const cur = match.other[k];
      if (cur !== undefined && !eqAddr(cur, v)) {
        throw new ImportError(
          `version ${incoming.release}.${incoming.build} on plugins.${slug}: other.${k} mismatch (book=${cur}, artifact=${v})`,
        );
      }
      if (cur === undefined) match.other[k] = v;
    }
  }
  return "noop";
}

// Merge `incoming.other` into `existing.other`. Returns per-key changes;
// throws on a value mismatch (identity fields never silently drift).
function mergeOther(existing: Plugin, incoming: Plugin, ctx: string): ("added" | "noop")[] {
  if (!incoming.other) return [];
  existing.other ??= {};
  const eqAddr = (a?: string, b?: string) => (a ?? "").toLowerCase() === (b ?? "").toLowerCase();
  const changes: ("added" | "noop")[] = [];
  for (const [k, v] of Object.entries(incoming.other)) {
    const cur = existing.other[k];
    if (cur === undefined) {
      existing.other[k] = v;
      changes.push("added");
    } else if (!eqAddr(cur, v)) {
      throw new ImportError(`${ctx}.${k} mismatch: book=${cur}, artifact=${v}`);
    } else {
      changes.push("noop");
    }
  }
  return changes;
}

// ---------------------------------------------------------------------------

function sortVersions<T extends { release: number; build: number }>(vs: T[]): T[] {
  return [...vs].sort((a, b) => a.release - b.release || a.build - b.build);
}

// Mutates: exactly the last entry gets `current: true`, everything else has it
// cleared. Empty arrays are left alone.
function stampCurrent(versions: PluginVersion[]): void {
  for (const v of versions) delete v.current;
  if (versions.length) versions[versions.length - 1].current = true;
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await Deno.readTextFile(path));
}

function firstZodError(err: { issues: { path: (string | number)[]; message: string }[] }): string {
  const i = err.issues[0];
  if (!i) return "unknown parse error";
  const p = i.path.length ? i.path.join(".") : "(root)";
  return `${p}: ${i.message}`;
}

function short(addr: string): string {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function relDisplay(p: string): string {
  const cwd = Deno.cwd();
  return p.startsWith(cwd) ? p.slice(cwd.length + 1) : p;
}

await main();
