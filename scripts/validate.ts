import { walk } from "@std/fs";
import { relative, resolve } from "@std/path";
import { AddressBook } from "./schema.ts";

const ADDRESSES_DIR = resolve(import.meta.dirname!, "..", "addresses");

// Group all .json entries under addresses/ by their realpath. Symlinks share
// a realpath with their target, so each real file is validated once but every
// alias is reported. That way a missing symlink shows up as an unpaired
// chainId file, and a broken symlink (dangling) surfaces as its own failure.
type Group = { primary: string; aliases: string[] };
const groups = new Map<string, Group>();
const brokenLinks: string[] = [];

for await (
  const entry of walk(ADDRESSES_DIR, { exts: [".json"], includeDirs: false, followSymlinks: false })
) {
  const rel = relative(ADDRESSES_DIR, entry.path);
  let real: string;
  try {
    real = await Deno.realPath(entry.path);
  } catch {
    brokenLinks.push(rel);
    continue;
  }
  const primary = relative(ADDRESSES_DIR, real);
  let g = groups.get(real);
  if (!g) {
    g = { primary, aliases: [] };
    groups.set(real, g);
  }
  if (rel !== primary) g.aliases.push(rel);
}

// Deterministic order: alphabetical by primary name.
const ordered = [...groups.values()].sort((a, b) => a.primary.localeCompare(b.primary));

let ok = 0;
let fail = 0;

for (const g of ordered) {
  const full = resolve(ADDRESSES_DIR, g.primary);
  let raw: unknown;
  try {
    raw = JSON.parse(await Deno.readTextFile(full));
  } catch (e) {
    console.error(formatLine("fail", g, `not valid JSON (${(e as Error).message})`));
    fail++;
    continue;
  }
  const parsed = AddressBook.safeParse(raw);
  if (parsed.success) {
    console.log(formatLine("ok", g));
    ok++;
  } else {
    console.error(formatLine("fail", g));
    for (const issue of parsed.error.issues) {
      const path = issue.path.length ? issue.path.join(".") : "(root)";
      console.error(`        ${path}: ${issue.message}`);
    }
    fail++;
  }
}

for (const b of brokenLinks) {
  console.error(`  fail  ${b}  (broken symlink)`);
  fail++;
}

console.log(`\n${ok} ok, ${fail} fail  (${groups.size} unique files, ${countAliases(ordered)} aliases)`);
Deno.exit(fail === 0 ? 0 : 1);

function formatLine(status: "ok" | "fail", g: Group, extra?: string): string {
  const aliasesPart = g.aliases.length ? `  (aka ${g.aliases.join(", ")})` : "";
  const extraPart = extra ? `  ${extra}` : "";
  return `  ${status}    ${g.primary}${aliasesPart}${extraPart}`;
}

function countAliases(groups: Group[]): number {
  return groups.reduce((n, g) => n + g.aliases.length, 0);
}
