import { describe, expect, it } from "vitest";
import {
  SCOPE_DESCRIPTORS,
  parseScopePrefix,
  prefixForScope,
  scopeForPrefix,
  writeScopePrefix,
} from "@/lib/commands/scopes";

describe("scopes", () => {
  it("lists every descriptor with a unique prefix", () => {
    const prefixes = SCOPE_DESCRIPTORS.map((d) => d.prefix);
    expect(new Set(prefixes).size).toBe(prefixes.length);
  });

  it("round-trips scope → prefix → scope", () => {
    for (const descriptor of SCOPE_DESCRIPTORS) {
      expect(prefixForScope(descriptor.scope)).toBe(descriptor.prefix);
      expect(scopeForPrefix(descriptor.prefix)).toBe(descriptor.scope);
    }
  });

  describe("parseScopePrefix", () => {
    it("returns null for an empty query", () => {
      expect(parseScopePrefix("")).toBeNull();
    });

    it("returns null when the first character is not a known prefix", () => {
      expect(parseScopePrefix("foo")).toBeNull();
      expect(parseScopePrefix("!foo")).toBeNull();
    });

    it("matches a prefix alone", () => {
      expect(parseScopePrefix(">")).toEqual({
        scope: "actions",
        restQuery: "",
      });
    });

    it("matches a prefix followed by text without a space", () => {
      expect(parseScopePrefix(">foo")).toEqual({
        scope: "actions",
        restQuery: "foo",
      });
    });

    it("strips a single leading space between the prefix and rest", () => {
      expect(parseScopePrefix("# hello")).toEqual({
        scope: "epics",
        restQuery: "hello",
      });
    });

    it("requires the prefix to be at index 0", () => {
      expect(parseScopePrefix(" >foo")).toBeNull();
      expect(parseScopePrefix("foo >bar")).toBeNull();
    });
  });

  describe("writeScopePrefix", () => {
    it("returns just the prefix for an empty rest", () => {
      expect(writeScopePrefix("actions", "")).toBe(">");
    });

    it("joins prefix and rest with a space", () => {
      expect(writeScopePrefix("epics", "search")).toBe("# search");
    });

    it("returns rest unchanged for an unknown scope (never happens at type level)", () => {
      // @ts-expect-error - assert runtime guard when the caller bypasses types.
      expect(writeScopePrefix("not-a-scope", "rest")).toBe("rest");
    });
  });
});
