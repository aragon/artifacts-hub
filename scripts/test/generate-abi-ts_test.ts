import { assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import { generateAbiTs } from "../generate-abi-ts.ts";

const abi = (name: string) => JSON.stringify([{ type: "function", name, inputs: [], outputs: [] }], null, 2) + "\n";

async function fixture(files: Record<string, string>): Promise<string> {
  const dir = await Deno.makeTempDir();
  for (const [path, content] of Object.entries(files)) {
    await Deno.mkdir(join(dir, path, ".."), { recursive: true });
    await Deno.writeTextFile(join(dir, path), content);
  }
  return dir;
}
const read = (dir: string, p: string) => Deno.readTextFile(join(dir, p));
const exists = (dir: string, p: string) => Deno.stat(join(dir, p)).then(() => true, () => false);

Deno.test("root mirrors the numerically latest version folder", async () => {
  const dir = await fixture({
    "lock-to-vote/v1.9/Old.json": abi("old"),
    "lock-to-vote/v1.10/Plugin.json": abi("v10"),
    "lock-to-vote/Stale.json": abi("stale"), // root file of a contract the latest version lacks
  });
  await generateAbiTs(dir);
  assertEquals(await read(dir, "lock-to-vote/Plugin.json"), abi("v10")); // byte-identical copy
  assertEquals(await exists(dir, "lock-to-vote/Old.json"), false);
  assertEquals(await exists(dir, "lock-to-vote/Stale.json"), false);
  assertEquals((await read(dir, "lock-to-vote/index.ts")).trim().split("\n").at(-1), `export * from "./v1.10/index.ts";`);
  assertEquals((await read(dir, "lock-to-vote/v1.9/index.ts")).includes(`export const OldABI = [{"type":"function","name":"old"`), true);
  assertEquals((await read(dir, "index.ts")).includes(`export * as lockToVote from "./lock-to-vote/index.ts";`), true);
});

Deno.test("--check reports drift without writing, then a regenerate is a no-op", async () => {
  const dir = await fixture({ "osx/v1.4.0/DAO.json": abi("dao") });
  const pending = await generateAbiTs(dir, { check: true });
  assertEquals(pending.length, 4); // version index, root copy, root index, abi/index.ts
  assertEquals(await exists(dir, "osx/DAO.json"), false);

  await generateAbiTs(dir);
  assertEquals(await generateAbiTs(dir, { check: true }), []);

  await Deno.writeTextFile(join(dir, "osx/DAO.json"), abi("hand-edited"));
  assertEquals(await generateAbiTs(dir, { check: true }), [join(dir, "osx/DAO.json")]);
});

Deno.test("a component without a version folder, or an empty one, is an error", async () => {
  const flat = await fixture({ "spp/Flat.json": abi("x") });
  await assertRejects(() => generateAbiTs(flat), Error, "abi/spp has no version folder");
  const empty = await fixture({ "spp/v1.1/.keep": "" });
  await assertRejects(() => generateAbiTs(empty), Error, "abi/spp/v1.1 has no ABI JSON");
});
