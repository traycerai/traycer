import { describe, expect, it } from "vitest";
import {
  isSearchRunSubpageId,
  parseSearchRunSubpageId,
  searchRunSubpageId,
  type SearchRunTarget,
} from "@/lib/commands/sources/open/search-target";

describe("search-target sub-page id round-trip", () => {
  const cases: ReadonlyArray<SearchRunTarget> = [
    { kind: "artifact" },
    { kind: "code", hostId: "host-a", root: "/ws/alpha" },
    // A Windows drive root contains `:` - encodeURIComponent escapes it, so it
    // cannot collide with the field separator.
    { kind: "code", hostId: "host-b", root: "C:\\Users\\dev\\repo" },
    // Colons and spaces in the root survive the round-trip.
    { kind: "code", hostId: "h:1", root: "/ws/a b:c/deep" },
  ];

  it.each(cases)("round-trips %o", (target) => {
    const id = searchRunSubpageId(target);
    expect(isSearchRunSubpageId(id)).toBe(true);
    expect(parseSearchRunSubpageId(id)).toEqual(target);
  });

  it("recognizes only search-run ids", () => {
    expect(isSearchRunSubpageId("open:files:ws:host:root")).toBe(false);
    expect(isSearchRunSubpageId("open:search:target:artifact")).toBe(false);
    expect(parseSearchRunSubpageId("open:files:x")).toBeNull();
  });
});
