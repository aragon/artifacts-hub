// Shared merge logic used by both `import-plugin.ts` (envelope-driven) and
// `refresh-plugin.ts` (on-chain-driven). Same invariants apply to both callers:
//
//   - Identity fields (repo, ens, maintainer) are per-chain constants: any
//     mismatch against an existing entry is a hard error.
//   - Versions are additive. Same (release, build) with same (setup, impl,
//     other) is a no-op; different addresses is a hard error.
//   - `current: true` is derived: after any merge, only the highest (release,
//     build) carries it.

import type { Plugin, PluginVersion } from "../schema.ts";

export class MergeError extends Error {}

// Mutates `book.plugins[slug]` in place; returns a human summary of the
// change ("no-op" / "added N versions" / "created" / …). Throws MergeError
// on any invariant violation.
export function mergePlugin(
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
  if (!eqAddr(existing.repo, incoming.repo)) {
    throw new MergeError(
      `repo mismatch on plugins.${slug}: book=${existing.repo}, incoming=${incoming.repo}`,
    );
  }
  if (existing.ens && incoming.ens && existing.ens !== incoming.ens) {
    throw new MergeError(
      `ens mismatch on plugins.${slug}: book=${existing.ens}, incoming=${incoming.ens}`,
    );
  }
  if (existing.maintainer && incoming.maintainer && !eqAddr(existing.maintainer, incoming.maintainer)) {
    throw new MergeError(
      `maintainer mismatch on plugins.${slug}: book=${existing.maintainer}, incoming=${incoming.maintainer}` +
        ` (ownership transfers should land as a reviewed PR, not through import)`,
    );
  }

  const otherChanges = mergeOther(existing, incoming, `plugins.${slug}.other`);

  const perVersion: string[] = [];
  for (const v of incoming.versions) {
    perVersion.push(mergeVersion(existing, v, slug));
  }

  const added = perVersion.filter((s) => s === "added").length;
  const noop = perVersion.filter((s) => s === "noop").length;
  const otherAdded = otherChanges.filter((s) => s === "added").length;

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

function mergeVersion(existing: Plugin, incoming: PluginVersion, slug: string): "added" | "noop" {
  const match = existing.versions.find(
    (v) => v.release === incoming.release && v.build === incoming.build,
  );
  if (!match) {
    const { current: _drop, ...clean } = incoming;
    existing.versions.push(clean);
    return "added";
  }
  if (!eqAddr(match.setup, incoming.setup)) {
    throw new MergeError(
      `version ${incoming.release}.${incoming.build} on plugins.${slug}: setup mismatch (book=${match.setup}, incoming=${incoming.setup})`,
    );
  }
  if (match.implementation && incoming.implementation && !eqAddr(match.implementation, incoming.implementation)) {
    throw new MergeError(
      `version ${incoming.release}.${incoming.build} on plugins.${slug}: implementation mismatch (book=${match.implementation}, incoming=${incoming.implementation})`,
    );
  }
  // If the book didn't have an implementation and the incoming does, adopt it.
  if (!match.implementation && incoming.implementation) {
    match.implementation = incoming.implementation;
  }
  if (incoming.other) {
    match.other ??= {};
    for (const [k, v] of Object.entries(incoming.other)) {
      const cur = match.other[k];
      if (cur !== undefined && !eqAddr(cur, v)) {
        throw new MergeError(
          `version ${incoming.release}.${incoming.build} on plugins.${slug}: other.${k} mismatch (book=${cur}, incoming=${v})`,
        );
      }
      if (cur === undefined) match.other[k] = v;
    }
  }
  return "noop";
}

function mergeOther(existing: Plugin, incoming: Plugin, ctx: string): ("added" | "noop")[] {
  if (!incoming.other) return [];
  existing.other ??= {};
  const changes: ("added" | "noop")[] = [];
  for (const [k, v] of Object.entries(incoming.other)) {
    const cur = existing.other[k];
    if (cur === undefined) {
      existing.other[k] = v;
      changes.push("added");
    } else if (!eqAddr(cur, v)) {
      throw new MergeError(`${ctx}.${k} mismatch: book=${cur}, incoming=${v}`);
    } else {
      changes.push("noop");
    }
  }
  return changes;
}

function sortVersions<T extends { release: number; build: number }>(vs: T[]): T[] {
  return [...vs].sort((a, b) => a.release - b.release || a.build - b.build);
}

function stampCurrent(versions: PluginVersion[]): void {
  for (const v of versions) delete v.current;
  if (versions.length) versions[versions.length - 1].current = true;
}

function eqAddr(a?: string, b?: string): boolean {
  return (a ?? "").toLowerCase() === (b ?? "").toLowerCase();
}

function short(addr: string): string {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}
