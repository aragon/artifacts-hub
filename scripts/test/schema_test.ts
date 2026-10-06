import { assertEquals } from "@std/assert";
import { PluginVersion } from "../schema.ts";

const setup = "0x938da6b9b16078a999e33fe4e37b243c40c7680b";

Deno.test("implementation 0x0 is rejected: omit it instead", () => {
  const r = PluginVersion.safeParse({ release: 1, build: 1, setup, implementation: "0x" + "0".repeat(40) });
  assertEquals(r.success, false);
});

Deno.test("placeholder is either true or absent", () => {
  assertEquals(PluginVersion.safeParse({ release: 1, build: 1, setup, placeholder: true }).success, true);
  assertEquals(PluginVersion.safeParse({ release: 1, build: 1, setup, placeholder: false }).success, false);
});
