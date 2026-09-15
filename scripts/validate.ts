import { walk } from "@std/fs";
import { relative, resolve } from "@std/path";
import { AddressBook } from "./schema.ts";

const ADDRESSES_DIR = resolve(import.meta.dirname!, "..", "addresses");

const seen = new Set<string>();
let ok = 0;
let fail = 0;

for await (
  const entry of walk(ADDRESSES_DIR, { exts: [".json"], includeDirs: false })
) {
  // Symlinks (e.g. citrea.json -> 4114.json) resolve to the same realpath as
  // their target; walk once per unique file so we don't double-report.
  const real = await Deno.realPath(entry.path);
  if (seen.has(real)) continue;
  seen.add(real);

  const rel = relative(ADDRESSES_DIR, entry.path);
  let raw: unknown;
  try {
    raw = JSON.parse(await Deno.readTextFile(real));
  } catch (e) {
    console.error(`  fail  ${rel}: not valid JSON (${(e as Error).message})`);
    fail++;
    continue;
  }

  const parsed = AddressBook.safeParse(raw);
  if (parsed.success) {
    console.log(`  ok    ${rel}`);
    ok++;
  } else {
    console.error(`  fail  ${rel}`);
    for (const issue of parsed.error.issues) {
      const path = issue.path.length ? issue.path.join(".") : "(root)";
      console.error(`        ${path}: ${issue.message}`);
    }
    fail++;
  }
}

console.log(`\n${ok} ok, ${fail} fail`);
Deno.exit(fail === 0 ? 0 : 1);
