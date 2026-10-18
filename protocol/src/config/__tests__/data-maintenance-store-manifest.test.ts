import { describe, expect, it } from "vitest";
import {
  storeKeySchema,
  storeManifestDigest,
  storeManifestSchema,
  type StoreManifestEntry,
} from "../data-migration-contracts";

function entry(
  storeKey: string,
  fields: StoreManifestEntry["fields"],
): StoreManifestEntry {
  return {
    storeKey,
    adapterId: "adapter",
    adapterVersion: 1,
    format: "fmt",
    disposition: "repair",
    fields,
  };
}

describe("storeKeySchema", () => {
  it("accepts root-relative canonical keys", () => {
    expect(storeKeySchema.safeParse("a").success).toBe(true);
    expect(storeKeySchema.safeParse("epics/e1/epic-homes.db").success).toBe(
      true,
    );
  });

  it.each([
    ["absolute", "/a/b"],
    ["drive", "C:/a"],
    ["drive without slash", "c:a"],
    ["backslash", "a\\b"],
    ["parent segment", "a/../b"],
    ["dot segment", "./a"],
    ["empty segment", "a//b"],
    ["trailing slash", "a/"],
    ["empty", ""],
  ])("rejects %s", (_name, key) => {
    expect(storeKeySchema.safeParse(key).success).toBe(false);
  });
});

describe("store manifest", () => {
  const first = entry("a/one", [
    { field: "t.x", rule: "rebase-under-root", matches: 2 },
    { field: "t.a", rule: "preserve", matches: 0 },
  ]);
  const second = entry("b/two", [
    { field: "t.y", rule: "scan-refuse", matches: 1 },
  ]);

  it("rejects duplicate store keys and accepts distinct ones", () => {
    expect(storeManifestSchema.safeParse([first, second]).success).toBe(true);
    expect(
      storeManifestSchema.safeParse([first, { ...second, storeKey: "a/one" }])
        .success,
    ).toBe(false);
  });

  it("digests independently of entry and field order, and reacts to a changed match count", () => {
    const shuffled = [
      { ...second },
      { ...first, fields: [...first.fields].reverse() },
    ];
    expect(storeManifestDigest(shuffled)).toBe(
      storeManifestDigest([first, second]),
    );
    const changed = [
      {
        ...first,
        fields: [
          { field: "t.x", rule: "rebase-under-root", matches: 3 },
          first.fields[1],
        ],
      },
      second,
    ];
    expect(storeManifestDigest(changed)).not.toBe(
      storeManifestDigest([first, second]),
    );
  });
});
