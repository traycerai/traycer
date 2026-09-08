import { describe, expect, it } from "vitest";
import type { WorkspaceAppearanceRead } from "@traycer/protocol/host/workspace/appearance-schemas";
import { mergeAppearanceRead } from "../resolve-appearance";

function read(
  overrides: Partial<WorkspaceAppearanceRead> & {
    readonly status: WorkspaceAppearanceRead["status"];
  },
): WorkspaceAppearanceRead {
  return {
    workspacePath: "/repo",
    canonicalSourceRoot: "/repo/.git-root",
    appearance: null,
    issues: [],
    ...overrides,
  };
}

describe("mergeAppearanceRead", () => {
  it("clears appearance on 'absent' even when a previous snapshot had one", () => {
    const previous = read({
      status: "present",
      appearance: { version: 1, color: "#112233" },
    });
    const next = read({ status: "absent", appearance: null });

    expect(mergeAppearanceRead(next, previous).appearance).toBeNull();
  });

  it("clears appearance on 'non-git' even when a previous snapshot had one", () => {
    const previous = read({
      status: "present",
      appearance: { version: 1, color: "#112233" },
    });
    const next = read({ status: "non-git", appearance: null });

    expect(mergeAppearanceRead(next, previous).appearance).toBeNull();
  });

  it("falls back to the previous snapshot's full appearance on 'malformed' for the same source root", () => {
    const previous = read({
      status: "present",
      canonicalSourceRoot: "/repo/.git-root",
      appearance: { version: 1, color: "#112233" },
    });
    const next = read({
      status: "malformed",
      canonicalSourceRoot: "/repo/.git-root",
      appearance: null,
      issues: ["appearance.json is not valid JSON"],
    });

    const merged = mergeAppearanceRead(next, previous);
    expect(merged.appearance).toEqual(previous.appearance);
    // Non-appearance fields come from the NEW read, not the snapshot.
    expect(merged.status).toBe("malformed");
    expect(merged.issues).toEqual(next.issues);
  });

  it("falls back to the previous snapshot on 'unavailable' too", () => {
    const previous = read({
      status: "present",
      appearance: { version: 1, color: "#112233" },
    });
    const merged = mergeAppearanceRead(
      read({ status: "unavailable", appearance: null }),
      previous,
    );
    expect(merged.appearance).toEqual(previous.appearance);
  });

  it("does not fall back when the previous snapshot is for a different source root", () => {
    const previous = read({
      status: "present",
      canonicalSourceRoot: "/repo/other-root",
      appearance: { version: 1, color: "#112233" },
    });
    const next = read({
      status: "malformed",
      canonicalSourceRoot: "/repo/.git-root",
      appearance: null,
    });

    expect(mergeAppearanceRead(next, previous).appearance).toBeNull();
  });

  it("does not fall back when there is no previous snapshot", () => {
    const next = read({ status: "unavailable", appearance: null });
    expect(mergeAppearanceRead(next, null).appearance).toBeNull();
  });

  it("does not fall back when the new read itself has no canonical source root", () => {
    const previous = read({
      status: "present",
      canonicalSourceRoot: null,
      appearance: { version: 1, color: "#112233" },
    });
    const next = read({
      status: "malformed",
      canonicalSourceRoot: null,
      appearance: null,
    });

    expect(mergeAppearanceRead(next, previous).appearance).toBeNull();
  });

  it("passes a 'present' read with a neutral (all-default) appearance through unchanged, without ever consulting the cache", () => {
    // The host's `parseAppearance` always produces a `{ version }` object for
    // a 'present' status - `appearance: null` paired with 'present' is not a
    // real host output; a neutral/all-default config is.
    const previous = read({
      status: "present",
      appearance: { version: 1, color: "#112233" },
    });
    const next = read({ status: "present", appearance: { version: 1 } });

    expect(mergeAppearanceRead(next, previous)).toEqual(next);
  });

  it("returns a clean 'present' read unchanged when it reports no issues", () => {
    const next = read({
      status: "present",
      appearance: { version: 1, color: "#445566" },
      issues: [],
    });

    expect(mergeAppearanceRead(next, null).appearance).toEqual(next.appearance);
  });

  it("retains only the cached color field when 'color' is a flagged issue", () => {
    const previous = read({
      status: "present",
      appearance: {
        version: 1,
        color: "#112233",
        icon: { kind: "emoji", value: "\u{1f4c1}" },
      },
    });
    const next = read({
      status: "present",
      appearance: {
        version: 1,
        icon: { kind: "emoji", value: "\u{1f680}" },
      },
      issues: ["color"],
    });

    const merged = mergeAppearanceRead(next, previous);
    expect(merged.appearance?.color).toBe("#112233");
    // The new read's own icon is authoritative and untouched.
    expect(merged.appearance?.icon).toEqual({
      kind: "emoji",
      value: "\u{1f680}",
    });
  });

  it("backfills a missing icon from cache only when 'icon' is flagged AND the new read omits it", () => {
    const cachedIcon = {
      kind: "image",
      path: "appearance/old.png",
    } satisfies NonNullable<WorkspaceAppearanceRead["appearance"]>["icon"];
    const previous = read({
      status: "present",
      appearance: { version: 1, icon: cachedIcon },
    });
    const next = read({
      status: "present",
      appearance: { version: 1 },
      issues: ["icon"],
    });

    expect(mergeAppearanceRead(next, previous).appearance?.icon).toEqual(
      cachedIcon,
    );
  });

  it("keeps the host's own icon when the host still returns one despite the flagged issue", () => {
    const cachedIcon = {
      kind: "image",
      path: "appearance/old.png",
    } satisfies NonNullable<WorkspaceAppearanceRead["appearance"]>["icon"];
    const freshIcon = { ...cachedIcon, path: "appearance/new.png" };
    const previous = read({
      status: "present",
      appearance: { version: 1, icon: cachedIcon },
    });
    const next = read({
      status: "present",
      appearance: { version: 1, icon: freshIcon },
      issues: ["icon"],
    });

    expect(mergeAppearanceRead(next, previous).appearance?.icon).toEqual(
      freshIcon,
    );
  });

  it("does not invent an icon field when 'icon' is flagged but nothing was ever cached", () => {
    const next = read({
      status: "present",
      appearance: { version: 1, color: "#112233" },
      issues: ["icon"],
    });

    expect(mergeAppearanceRead(next, null).appearance).toEqual(next.appearance);
  });

  it("keeps the host's own color when the host still returns one despite the flagged issue", () => {
    const previous = read({
      status: "present",
      appearance: { version: 1, color: "#112233" },
    });
    const next = read({
      status: "present",
      appearance: { version: 1, color: "#445566" },
      issues: ["color"],
    });

    expect(mergeAppearanceRead(next, previous).appearance?.color).toBe(
      "#445566",
    );
  });

  // A partial `malformed` (the host validated some fields, flagged the rest via
  // `issues`, and still returned the appearance it could salvage) merges
  // field-by-field exactly like `present` - only a WHOLE malformed read
  // (`appearance: null`) falls back to the entire cached snapshot.
  it("applies the same per-field merge to a 'malformed' read that still carries a partial appearance", () => {
    const previous = read({
      status: "present",
      appearance: {
        version: 1,
        color: "#112233",
        icon: { kind: "emoji", value: "\u{1f4c1}" },
      },
    });
    const next = read({
      status: "malformed",
      appearance: {
        version: 1,
        icon: { kind: "emoji", value: "\u{1f680}" },
      },
      issues: ["color"],
    });

    const merged = mergeAppearanceRead(next, previous);
    // Flagged AND missing from the new read -> backfilled from cache.
    expect(merged.appearance?.color).toBe("#112233");
    // Explicitly returned by the host (even though not the flagged field) ->
    // authoritative, never backfilled.
    expect(merged.appearance?.icon).toEqual({
      kind: "emoji",
      value: "\u{1f680}",
    });
  });

  it("still falls back to the whole cached snapshot for a totally malformed read (no salvageable appearance)", () => {
    const previous = read({
      status: "present",
      appearance: { version: 1, color: "#112233" },
    });
    const next = read({
      status: "malformed",
      appearance: null,
      issues: ["appearance.json is not valid JSON"],
    });

    expect(mergeAppearanceRead(next, previous).appearance).toEqual(
      previous.appearance,
    );
  });
});
