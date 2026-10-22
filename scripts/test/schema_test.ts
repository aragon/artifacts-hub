import { assertEquals } from "@std/assert";
import { Address, findUnchecksummed, PluginVersion } from "../schema.ts";

const setup = "0x938da6b9b16078a999e33fe4e37b243c40c7680b";

Deno.test("implementation 0x0 is rejected: omit it instead", () => {
  const r = PluginVersion.safeParse({ release: 1, build: 1, setup, implementation: "0x" + "0".repeat(40) });
  assertEquals(r.success, false);
});

Deno.test("placeholder is either true or absent", () => {
  assertEquals(PluginVersion.safeParse({ release: 1, build: 1, setup, placeholder: true }).success, true);
  assertEquals(PluginVersion.safeParse({ release: 1, build: 1, setup, placeholder: false }).success, false);
});

// Address casing: stored EIP-55, typos caught.
const checksummed = "0x938DA6B9B16078a999E33FE4E37b243C40c7680b";

Deno.test("Address: lowercase input is stored checksummed", () => {
  assertEquals(Address.parse(checksummed.toLowerCase()), checksummed);
});

Deno.test("Address: a valid checksum is kept", () => {
  assertEquals(Address.parse(checksummed), checksummed);
});

Deno.test("Address: mixed case with a wrong checksum is rejected", () => {
  const typo = checksummed.slice(0, -1) + "B"; // last char flipped to upper case
  assertEquals(Address.safeParse(typo).success, false);
});

Deno.test("Address: all-uppercase hex is rejected (not lowercase, not a valid checksum)", () => {
  assertEquals(Address.safeParse("0x" + checksummed.slice(2).toUpperCase()).success, false);
});

Deno.test("Address: zero address parses (all digits, no case)", () => {
  assertEquals(Address.parse("0x" + "0".repeat(40)), "0x" + "0".repeat(40));
});

Deno.test("findUnchecksummed reports the path of every unchecksummed address", () => {
  const book = {
    chainId: 1,
    plugins: { admin: { repo: checksummed, versions: [{ setup: checksummed.toLowerCase() }] } },
    deployers: { protocolFactory: checksummed.toLowerCase() },
    ens: "admin.plugin.dao.eth", // non-address strings are ignored
  };
  assertEquals(findUnchecksummed(book), ["plugins.admin.versions.0.setup", "deployers.protocolFactory"]);
});

Deno.test("findUnchecksummed accepts a fully checksummed book", () => {
  assertEquals(findUnchecksummed({ a: [checksummed, { b: checksummed }] }), []);
});
