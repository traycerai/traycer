import { describe, expect, it } from "vitest";
import type { GuiHarnessOption } from "@traycer/protocol/host/index";
import { guiHarnessOptionSchema } from "@traycer/protocol/host/agent/gui/unary-schemas";
import type { AutoJudgeSelection } from "@traycer/protocol/host/auto-mode/contracts";
import { autoJudgeSeed } from "@/components/settings/panels/auto-judge-selection";

function harness(overrides: Partial<GuiHarnessOption> = {}): GuiHarnessOption {
  return guiHarnessOptionSchema.parse({
    id: "claude",
    label: "Claude Code",
    available: true,
    error: null,
    modes: ["gui"],
    requiresApiKey: false,
    ...overrides,
  });
}

describe("autoJudgeSeed", () => {
  it("seeds the unset state with the empty-model traycer harness when selection is null", () => {
    const seed = autoJudgeSeed(null, [harness()]);

    expect(seed.seedKey).toBe("unset");
    expect(seed.values.selection).toEqual({
      harnessId: "traycer",
      modelSlug: "",
      profileId: null,
    });
    expect(seed.unrecognizedHarnessId).toBeNull();
  });

  it("seeds the loading state when the catalog has not resolved yet", () => {
    const selection: AutoJudgeSelection = {
      harnessId: "claude",
      model: "claude-sonnet",
      profileId: null,
    };
    const seed = autoJudgeSeed(selection, undefined);

    expect(seed.seedKey).toBe("loading");
    expect(seed.values.selection).toEqual({
      harnessId: "traycer",
      modelSlug: "",
      profileId: null,
    });
    expect(seed.unrecognizedHarnessId).toBeNull();
  });

  it("flags a stored harness id absent from the loaded catalog rows", () => {
    const selection: AutoJudgeSelection = {
      harnessId: "some-future-harness",
      model: "some-model",
      profileId: null,
    };
    const seed = autoJudgeSeed(selection, [harness({ id: "claude" })]);

    expect(seed.seedKey).toBe("unrecognized:some-future-harness");
    expect(seed.unrecognizedHarnessId).toBe("some-future-harness");
    expect(seed.values.selection).toEqual({
      harnessId: "traycer",
      modelSlug: "",
      profileId: null,
    });
  });

  it("resolves the stored harness/model/profile when the id is present in the catalog rows", () => {
    const selection: AutoJudgeSelection = {
      harnessId: "claude",
      model: "claude-sonnet",
      profileId: "profile-1",
    };
    const seed = autoJudgeSeed(selection, [harness({ id: "claude" })]);

    expect(seed.unrecognizedHarnessId).toBeNull();
    expect(seed.values.selection).toEqual({
      harnessId: "claude",
      modelSlug: "claude-sonnet",
      profileId: "profile-1",
    });
    expect(seed.values.reasoning).toBe("");
    expect(seed.values.serviceTier).toBe("");
    // The catalog row's label, not the wire id: it is what the row's
    // "isn't available on this machine" line prints. Asserted because this is
    // the ONE branch that has a label to carry, so it is the one branch where
    // a missing key would go unnoticed - vitest never type-checks, and the
    // three other branches all set it to null.
    expect(seed.storedHarnessLabel).toBe("Claude Code");
  });

  it("carries no harness label on any branch that has no resolved row", () => {
    const unresolvable: AutoJudgeSelection = {
      harnessId: "some-future-harness",
      model: "some-model",
      profileId: null,
    };
    expect(autoJudgeSeed(null, [harness()]).storedHarnessLabel).toBeNull();
    expect(
      autoJudgeSeed(unresolvable, undefined).storedHarnessLabel,
    ).toBeNull();
    expect(
      autoJudgeSeed(unresolvable, [harness({ id: "claude" })])
        .storedHarnessLabel,
    ).toBeNull();
  });
});
