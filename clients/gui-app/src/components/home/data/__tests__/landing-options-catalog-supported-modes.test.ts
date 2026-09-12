import { describe, expect, it } from "vitest";
import { guiHarnessOptionSchema } from "@traycer/protocol/host/index";
import type { GuiHarnessOption } from "@traycer/protocol/host/index";
import {
  catalogSupportedPermissionModes,
  unsupportedPermissionModeCopy,
  type PermissionMode,
} from "@/components/home/data/landing-options";

function harness(
  id: string,
  supportedPermissionModes: ReadonlyArray<PermissionMode>,
): GuiHarnessOption {
  return guiHarnessOptionSchema.parse({
    id,
    label: id,
    available: true,
    error: null,
    modes: ["gui"],
    requiresApiKey: false,
    supportedPermissionModes,
  });
}

describe("catalogSupportedPermissionModes", () => {
  it("returns null when the catalog is undefined - still loading", () => {
    expect(catalogSupportedPermissionModes(undefined)).toBeNull();
  });

  it("returns null for an empty catalog", () => {
    expect(catalogSupportedPermissionModes([])).toBeNull();
  });

  it("returns null when every row declares an empty supported set", () => {
    expect(
      catalogSupportedPermissionModes([
        harness("cursor", []),
        harness("codex", []),
      ]),
    ).toBeNull();
  });

  it("unions across rows, deduped, in PERMISSION_OPTIONS order", () => {
    const result = catalogSupportedPermissionModes([
      harness("codex", ["auto_accept_edits", "supervised"]),
      harness("claude", ["auto", "supervised", "full_access"]),
    ]);
    expect(result).toEqual([
      "supervised",
      "auto_accept_edits",
      "auto",
      "full_access",
    ]);
  });

  it("excludes auto when no row in the catalog honors it", () => {
    const result = catalogSupportedPermissionModes([
      harness("cursor", ["full_access"]),
      harness("codex", ["supervised", "auto_accept_edits"]),
    ]);
    expect(result).not.toBeNull();
    expect(result).not.toContain("auto");
  });
});

describe("unsupportedPermissionModeCopy", () => {
  it("blames a newer Traycer when the catalog lists modes but none includes auto", () => {
    expect(
      unsupportedPermissionModeCopy({
        mode: "auto",
        harnessLabel: "Claude Code",
        catalogSupportedModes: [
          "supervised",
          "auto_accept_edits",
          "full_access",
        ],
      }),
    ).toBe("Needs a newer Traycer on this machine.");
  });

  it("blames the provider when the catalog carries auto elsewhere but not on this row", () => {
    expect(
      unsupportedPermissionModeCopy({
        mode: "auto",
        harnessLabel: "Claude Code",
        catalogSupportedModes: [
          "supervised",
          "auto_accept_edits",
          "auto",
          "full_access",
        ],
      }),
    ).toBe("Not supported by Claude Code.");
  });

  it("blames the provider when catalogSupportedModes is null - not known yet", () => {
    expect(
      unsupportedPermissionModeCopy({
        mode: "auto",
        harnessLabel: "Claude Code",
        catalogSupportedModes: null,
      }),
    ).toBe("Not supported by Claude Code.");
  });

  it("falls back to the generic 'this provider' when harnessLabel is null", () => {
    expect(
      unsupportedPermissionModeCopy({
        mode: "auto",
        harnessLabel: null,
        catalogSupportedModes: null,
      }),
    ).toBe("Not supported by this provider.");
  });
});
