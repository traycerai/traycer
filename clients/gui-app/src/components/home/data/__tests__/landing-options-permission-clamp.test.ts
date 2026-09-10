import { describe, expect, it } from "vitest";
import {
  PERMISSION_OPTIONS,
  fallbackPermissionMode,
  findPermissionOption,
  isPermissionMode,
  normalizePermissionMode,
  type PermissionMode,
} from "@/components/home/data/landing-options";

describe("normalizePermissionMode", () => {
  it("demotes sticky auto to auto_accept_edits on an old host that serves the pre-auto trio - THE regression this ticket exists for", () => {
    expect(
      normalizePermissionMode("auto", [
        "supervised",
        "auto_accept_edits",
        "full_access",
      ]),
    ).toBe("auto_accept_edits");
  });

  it("falls back to the safest supported mode when the host doesn't even honor auto_accept_edits", () => {
    expect(normalizePermissionMode("auto", ["supervised", "full_access"])).toBe(
      "supervised",
    );
  });

  it("leaves auto unchanged when the host's row includes it", () => {
    expect(normalizePermissionMode("auto", ["auto", "full_access"])).toBe(
      "auto",
    );
  });

  it("passes every value through untouched, auto included, when supportedPermissionModes is null", () => {
    const modes: ReadonlyArray<PermissionMode> = [
      "supervised",
      "auto_accept_edits",
      "auto",
      "full_access",
    ];
    for (const mode of modes) {
      expect(normalizePermissionMode(mode, null)).toBe(mode);
    }
  });

  it("passes every value through untouched, auto included, when supportedPermissionModes is empty", () => {
    const modes: ReadonlyArray<PermissionMode> = [
      "supervised",
      "auto_accept_edits",
      "auto",
      "full_access",
    ];
    for (const mode of modes) {
      expect(normalizePermissionMode(mode, [])).toBe(mode);
    }
  });

  it("elevates sticky supervised to full_access when that's all Cursor's row supports", () => {
    expect(normalizePermissionMode("supervised", ["full_access"])).toBe(
      "full_access",
    );
  });

  it("REGRESSION GUARD: clamps sticky full_access down to supervised when the row lacks a declared fallback for it", () => {
    // full_access has no declared PERMISSION_FALLBACK_MODE entry, so the
    // safest-supported walk still owns this case - unchanged behaviour.
    expect(
      normalizePermissionMode("full_access", [
        "supervised",
        "auto_accept_edits",
      ]),
    ).toBe("supervised");
  });
});

describe("fallbackPermissionMode", () => {
  it("demotes auto to auto_accept_edits", () => {
    expect(fallbackPermissionMode("auto")).toBe("auto_accept_edits");
  });

  it("answers every other mode with itself", () => {
    expect(fallbackPermissionMode("supervised")).toBe("supervised");
    expect(fallbackPermissionMode("auto_accept_edits")).toBe(
      "auto_accept_edits",
    );
    expect(fallbackPermissionMode("full_access")).toBe("full_access");
  });
});

describe("PERMISSION_OPTIONS", () => {
  it("renders all four ids in most-restrictive-to-most-permissive order, auto between auto_accept_edits and full_access", () => {
    expect(PERMISSION_OPTIONS.map((option) => option.id)).toEqual([
      "supervised",
      "auto_accept_edits",
      "auto",
      "full_access",
    ]);
  });

  it("recognizes auto as a permission mode with the label Auto", () => {
    expect(isPermissionMode("auto")).toBe(true);
    expect(findPermissionOption("auto").label).toBe("Auto");
  });
});
