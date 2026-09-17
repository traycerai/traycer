import { describe, expect, it } from "vitest";
import { agentGuiListHarnessesV91 } from "@traycer/protocol/host/agent/gui/contracts";
import type { SchemaVersion } from "@traycer/protocol/framework/index";
import { guiHarnessOptionSchema } from "@traycer/protocol/host/agent/gui/unary-schemas";
import type { GuiHarnessOption } from "@traycer/protocol/host/index";
import {
  PERMISSION_OPTIONS,
  autoModeOfferableHere,
  catalogLineKnowsAutoMode,
  catalogSupportedPermissionModes,
  composerOffersPermissionMode,
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

// FIX 2 (P1): the ROW's constraint and the HOST's own line are two different
// questions - a pre-`auto` host serves unconstrained rows like any other, so
// the row predicate alone lit up an option the wire cannot carry.
describe("composerOffersPermissionMode", () => {
  // `null` = no host in scope passes through; `false` = a host said no vetoes.
  it("offers auto when no host is in scope (null) and vetoes only on false", () => {
    expect(composerOffersPermissionMode([], "auto", null)).toBe(true);
    expect(composerOffersPermissionMode(null, "auto", null)).toBe(true);
    expect(composerOffersPermissionMode([], "auto", false)).toBe(false);
  });
  it("withholds auto from an unconstrained row when the host cannot spell it", () => {
    expect(composerOffersPermissionMode([], "auto", false)).toBe(false);
  });

  it("offers auto from the same unconstrained row once the host proves it can spell it", () => {
    expect(composerOffersPermissionMode([], "auto", true)).toBe(true);
  });

  it("leaves every non-auto mode unaffected by hostKnowsAutoMode", () => {
    const nonAutoModes: ReadonlyArray<PermissionMode> = [
      "supervised",
      "auto_accept_edits",
      "full_access",
    ];
    for (const mode of nonAutoModes) {
      expect(composerOffersPermissionMode([], mode, false)).toBe(
        composerOffersPermissionMode([], mode, true),
      );
      expect(composerOffersPermissionMode([], mode, false)).toBe(true);
    }
  });

  it("still withholds a mode the ROW itself refuses, regardless of hostKnowsAutoMode", () => {
    const supported: ReadonlyArray<PermissionMode> = ["supervised"];
    expect(composerOffersPermissionMode(supported, "auto", true)).toBe(false);
    expect(composerOffersPermissionMode(supported, "full_access", true)).toBe(
      false,
    );
  });
});

describe("normalizePermissionMode", () => {
  // The THIRD state of the host proof, and the one a boolean cannot hold.
  // `null` is "no host is in scope" - Settings' install-wide default row, which
  // names no harness and no machine - and it must pass `auto` through, exactly
  // as a `null` `supportedPermissionModes` passes a mode through one dimension
  // over. `false` is the different claim "a machine was asked and cannot spell
  // it", and only that one demotes.
  //
  // Guarded here because the surface half of it lives in
  // `general-settings-panel.test.tsx`, and that suite cannot see the clamp: it
  // renders a picker, not this function. Collapsing `null` into `false` here -
  // `!hostKnowsAutoMode` instead of `hostKnowsAutoMode === false` - leaves that
  // panel suite GREEN and silently demotes every install-wide `auto` default.
  it("keeps auto when NO host is in scope (null), on an unconstrained row", () => {
    expect(normalizePermissionMode("auto", [], null)).toBe("auto");
  });

  it("keeps auto when no host is in scope and no harness is either", () => {
    expect(normalizePermissionMode("auto", null, null)).toBe("auto");
  });

  it("demotes auto when a host IS in scope and cannot spell it", () => {
    expect(normalizePermissionMode("auto", [], false)).toBe(
      "auto_accept_edits",
    );
  });

  it("demotes sticky auto to auto_accept_edits on an old host that serves the pre-auto trio - THE regression this ticket exists for", () => {
    expect(
      normalizePermissionMode(
        "auto",
        ["supervised", "auto_accept_edits", "full_access"],
        true,
      ),
    ).toBe("auto_accept_edits");
  });

  it("falls back to the safest supported mode when the host doesn't even honor auto_accept_edits", () => {
    expect(
      normalizePermissionMode("auto", ["supervised", "full_access"], true),
    ).toBe("supervised");
  });

  it("leaves auto unchanged when the host's row includes it", () => {
    expect(normalizePermissionMode("auto", ["auto", "full_access"], true)).toBe(
      "auto",
    );
  });

  // FIX 2 (P1): the HOST proof runs FIRST and is not foldable into the row
  // walk - a pre-`auto` host's rows are routinely unconstrained, so `auto`
  // would satisfy `harnessHonorsPermissionMode` and return on the first
  // branch without ever reaching a fallback. `null` here models exactly that:
  // "no harness scope yet", the row saying nothing either way.
  it("demotes sticky auto to auto_accept_edits when hostKnowsAutoMode is false, even with a null (unconstrained) row", () => {
    expect(normalizePermissionMode("auto", null, false)).toBe(
      "auto_accept_edits",
    );
  });

  // The literal shape of the P1 regression: an EMPTY (unconstrained) row -
  // exactly what a pre-`auto` host's `chat.subscribe` line routinely serves,
  // since such a host has no way to single `auto` out even if it wanted to -
  // still gets demoted once the host proof says no. Before this fix, the
  // unconstrained row alone satisfied `harnessHonorsPermissionMode` and
  // `auto` passed straight through.
  it("demotes sticky auto to auto_accept_edits when hostKnowsAutoMode is false, even with an empty (unconstrained) row", () => {
    expect(normalizePermissionMode("auto", [], false)).toBe(
      "auto_accept_edits",
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
      expect(normalizePermissionMode(mode, null, true)).toBe(mode);
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
      expect(normalizePermissionMode(mode, [], true)).toBe(mode);
    }
  });

  it("elevates sticky supervised to full_access when that's all Cursor's row supports", () => {
    expect(normalizePermissionMode("supervised", ["full_access"], true)).toBe(
      "full_access",
    );
  });

  it("REGRESSION GUARD: clamps sticky full_access down to supervised when the row lacks a declared fallback for it", () => {
    // full_access has no declared PERMISSION_FALLBACK_MODE entry, so the
    // safest-supported walk still owns this case - unchanged behaviour.
    expect(
      normalizePermissionMode(
        "full_access",
        ["supervised", "auto_accept_edits"],
        true,
      ),
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

// The `chat.subscribe` proof, which the catalog proof cannot supply - two
// independently-negotiated methods, both of which a chat composer needs
// before it may show/send `auto`. See `autoModeOfferableHere`'s doc comment.
describe("autoModeOfferableHere", () => {
  const belowCatalogLine: SchemaVersion = {
    major: AUTO_MODE_LINE.major,
    minor: AUTO_MODE_LINE.minor - 1,
  };

  it("catalog line below 9.1, chat line true -> false (the catalog still vetoes)", () => {
    expect(autoModeOfferableHere(belowCatalogLine, true)).toBe(false);
  });

  // THE FIX: gating on the catalog line alone previously let this through as
  // `true`, offering `auto` on a chat whose negotiated `chat.subscribe` line
  // cannot carry it - the send then throws at the projection cliff.
  it("catalog line 9.1, chat line false -> false", () => {
    expect(autoModeOfferableHere(AUTO_MODE_LINE, false)).toBe(false);
  });

  it("catalog line 9.1, chat line true -> true", () => {
    expect(autoModeOfferableHere(AUTO_MODE_LINE, true)).toBe(true);
  });

  it("catalog line 9.1, chat line null -> true (no chat in scope: the catalog decides alone)", () => {
    expect(autoModeOfferableHere(AUTO_MODE_LINE, null)).toBe(true);
  });

  it("catalog line null, chat line true -> false", () => {
    expect(autoModeOfferableHere(null, true)).toBe(false);
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
