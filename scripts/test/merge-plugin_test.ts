import { assertEquals, assertThrows } from "@std/assert";
import { MergeError, mergePlugin, stampCurrent } from "../lib/merge-plugin.ts";
import type { Plugin, PluginVersion } from "../schema.ts";

const a = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
const repo = a(100);
const v = (build: number, extra: Partial<PluginVersion> = {}): PluginVersion => ({ release: 1, build, setup: a(build), ...extra });
const book = (versions: PluginVersion[]) => ({ plugins: { spp: { repo, versions } as Plugin } });
const currentBuild = (b: { plugins: Record<string, Plugin> }) => b.plugins.spp.versions.find((x) => x.current)?.build;

Deno.test("stampCurrent marks the highest non-placeholder build", () => {
  const vs = [v(1), v(2, { current: true }), v(3, { placeholder: true })];
  stampCurrent(vs);
  assertEquals(vs.map((x) => !!x.current), [false, true, false]);
});

Deno.test("stampCurrent leaves no current when every build is a placeholder", () => {
  const vs = [v(1, { placeholder: true }), v(2, { placeholder: true })];
  stampCurrent(vs);
  assertEquals(vs.some((x) => x.current), false);
});

Deno.test("a re-read adopts the placeholder flag as an update", () => {
  const b = book([v(1, { setup: a(9) }), v(2, { current: true })]);
  const summary = mergePlugin(b, "spp", { repo, versions: [v(1, { setup: a(9), placeholder: true }), v(2)] });
  assertEquals(summary, "updated 1 version, 1 no-op");
  assertEquals(b.plugins.spp.versions[0].placeholder, true);
  assertEquals(currentBuild(b), 2);
});

Deno.test("adopting a missing implementation is an update, so refresh persists it", () => {
  const b = book([v(1, { current: true })]);
  assertEquals(mergePlugin(b, "spp", { repo, versions: [v(1, { implementation: a(50) })] }), "updated 1 version");
  assertEquals(b.plugins.spp.versions[0].implementation, a(50));
});

Deno.test("an unflagged incoming build doesn't clear the book's flag", () => {
  const b = book([v(1, { placeholder: true }), v(2, { current: true })]);
  assertEquals(mergePlugin(b, "spp", { repo, versions: [v(1), v(2)] }), "2 no-op");
  assertEquals(b.plugins.spp.versions[0].placeholder, true);
});

Deno.test("a placeholder can't have an implementation in the book", () => {
  const b = book([v(1, { implementation: a(50), current: true })]);
  assertThrows(() => mergePlugin(b, "spp", { repo, versions: [v(1, { placeholder: true })] }), MergeError, "placeholder");
});

Deno.test("new builds: placeholders appended, current stays on the real highest build", () => {
  // Fresh repo published as placeholder 1..2 then the real build 3, read out of order.
  const b = book([]);
  delete (b.plugins as Record<string, unknown>).spp;
  mergePlugin(b, "spp", { repo, versions: [v(3), v(1, { placeholder: true }), v(2, { placeholder: true })] });
  assertEquals(b.plugins.spp.versions.map((x) => x.build), [1, 2, 3]);
  assertEquals(currentBuild(b), 3);
});
