import { assertEquals } from "@std/assert";
import { isPlaceholderRevert, PLACEHOLDER_ERROR, toPluginVersion } from "../lib/read-plugin-repo.ts";

const setup = "0x938da6b9b16078a999e33fe4e37b243c40c7680b";

Deno.test("PLACEHOLDER_ERROR is the selector observed on-chain", () => {
  assertEquals(PLACEHOLDER_ERROR, "0xa8a9f28c");
});

Deno.test("isPlaceholderRevert finds the selector wherever the provider puts it", () => {
  assertEquals(isPlaceholderRevert({ data: "0xa8a9f28c" }), true);
  assertEquals(isPlaceholderRevert({ message: "x", cause: { cause: { data: "0xA8A9F28C" } } }), true);
  assertEquals(isPlaceholderRevert({ details: "execution reverted: 0xa8a9f28c" }), true);
  assertEquals(isPlaceholderRevert({ data: { originalError: { data: "0xa8a9f28c" } } }), true);
});

Deno.test("isPlaceholderRevert rejects other reverts and junk", () => {
  assertEquals(isPlaceholderRevert({ data: "0x" }), false);
  assertEquals(isPlaceholderRevert({ data: "0x08c379a0" }), false);
  assertEquals(isPlaceholderRevert(new Error("execution reverted")), false);
  assertEquals(isPlaceholderRevert(undefined), false);
  assertEquals(isPlaceholderRevert("0xa8a9f28c"), false); // a bare string is not an error object
});

Deno.test("toPluginVersion omits absent fields instead of writing 0x0 or false", () => {
  const base = { release: 1, build: 1, setup, buildMetadata: "0x" } as const;
  assertEquals(toPluginVersion({ ...base, placeholder: true }), { release: 1, build: 1, setup, placeholder: true });
  assertEquals(toPluginVersion({ ...base, implementation: setup, placeholder: false }), {
    release: 1, build: 1, setup, implementation: setup,
  });
});
