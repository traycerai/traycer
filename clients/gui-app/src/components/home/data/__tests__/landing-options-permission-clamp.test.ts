import { describe, expect, it } from "vitest";
import { agentGuiListHarnessesV91 } from "@traycer/protocol/host/agent/gui/contracts";
import type { SchemaVersion } from "@traycer/protocol/framework/index";
import { guiHarnessOptionSchema } from "@traycer/protocol/host/agent/gui/unary-schemas";
import type { GuiHarnessOption } from "@traycer/protocol/host/index";
import {
  PERMISSION_OPTIONS,
  catalogLineKnowsAutoMode,
  catalogSupportedPermissionModes,
  fallbackPermissionMode,
  findPermissionOption,
  harnessHonorsPermissionMode,
  isPermissionMode,
  normalizePermissionMode,
  unsupportedPermissionModeCopy,
  type PermissionMode,
} from "@/components/home/data/landing-options";

function harnessRow(
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

const AUTO_MODE_LINE = agentGuiListHarnessesV91.schemaVersion;

const ALL_MODES: ReadonlyArray<PermissionMode> = PERMISSION_OPTIONS.map(
  (option) => option.id,
);

describe("harnessHonorsPermissionMode", () => {
  it("honors every mode when supportedPermissionModes is null - no harness scope yet", () => {
    for (const mode of ALL_MODES) {
      expect(harnessHonorsPermissionMode(null, mode)).toBe(true);
    }
  });

  it("honors every mode when supportedPermissionModes is an empty array - a harness that answered and constrained nothing", () => {
    for (const mode of ALL_MODES) {
      expect(harnessHonorsPermissionMode([], mode)).toBe(true);
    }
  });

  it("honors only the modes a populated array names", () => {
    const supported: ReadonlyArray<PermissionMode> = [
      "supervised",
      "full_access",
    ];
    expect(harnessHonorsPermissionMode(supported, "supervised")).toBe(true);
    expect(harnessHonorsPermissionMode(supported, "full_access")).toBe(true);
    expect(harnessHonorsPermissionMode(supported, "auto_accept_edits")).toBe(
      false,
    );
    expect(harnessHonorsPermissionMode(supported, "auto")).toBe(false);
  });
});

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

describe("catalogLineKnowsAutoMode", () => {
  it("answers false for null - no handshake recorded for this host yet", () => {
    expect(catalogLineKnowsAutoMode(null)).toBe(false);
  });

  it("answers true at the 9.1 line itself", () => {
    expect(catalogLineKnowsAutoMode(AUTO_MODE_LINE)).toBe(true);
  });

  it("answers true for a higher minor on the same major", () => {
    const higherMinor: SchemaVersion = {
      major: AUTO_MODE_LINE.major,
      minor: AUTO_MODE_LINE.minor + 1,
    };
    expect(catalogLineKnowsAutoMode(higherMinor)).toBe(true);
  });

  it("answers false for the minor just below the line, same major", () => {
    const lowerMinor: SchemaVersion = {
      major: AUTO_MODE_LINE.major,
      minor: AUTO_MODE_LINE.minor - 1,
    };
    expect(catalogLineKnowsAutoMode(lowerMinor)).toBe(false);
  });

  // A higher MAJOR is not evidence: the contract's own comment says a higher
  // major answers differently than a higher minor, unlike `versionIsBelow`'s
  // veto reading of the same manifest entry.
  it("answers false for a higher major - a higher major is not evidence", () => {
    // `minor` is set to the line's OWN minor (not 0) so a minor-only check
    // (major comparison dropped) would wrongly answer true here - this is
    // what makes the case actually exercise the major guard.
    const higherMajor: SchemaVersion = {
      major: AUTO_MODE_LINE.major + 1,
      minor: AUTO_MODE_LINE.minor,
    };
    expect(catalogLineKnowsAutoMode(higherMajor)).toBe(false);
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

// C5(a): an UNCONSTRAINED row makes the whole union unknowable - one row
// answering "all of them" and a second constraining to `["full_access"]`
// must still come out as `null`, never as the constrained row's own value.
describe("catalogSupportedPermissionModes - unconstrained row poisons the union", () => {
  it("returns null when one row is unconstrained (empty) alongside a constrained row", () => {
    const result = catalogSupportedPermissionModes([
      harnessRow("codex", []),
      harnessRow("claude", ["full_access"]),
    ]);

    expect(result).toBeNull();
  });
});

// C5(b): once the HOST's negotiated catalog line proves it can spell `auto`
// at all, an absent `auto` in a provider's own union is the PROVIDER'S doing,
// not a reason to send the user chasing a host update that would change
// nothing.
describe("unsupportedPermissionModeCopy - hostKnowsAutoMode veto", () => {
  it("blames the provider, not a newer Traycer, once hostKnowsAutoMode is true even though auto is absent from the union", () => {
    const copy = unsupportedPermissionModeCopy({
      mode: "auto",
      harnessLabel: "Claude Code",
      catalogSupportedModes: ["supervised", "auto_accept_edits", "full_access"],
      hostKnowsAutoMode: true,
    });

    expect(copy).toBe("Not supported by Claude Code.");
  });
});
