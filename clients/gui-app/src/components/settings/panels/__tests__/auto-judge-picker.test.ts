import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import type { GuiHarnessOption } from "@traycer/protocol/host/index";
import { guiHarnessOptionSchema } from "@traycer/protocol/host/agent/gui/unary-schemas";
import type {
  AutoJudgeEffective,
  AutoJudgeSelection,
} from "@traycer/protocol/host/auto-mode/contracts";
import { autoJudgeSeed } from "@/components/settings/panels/auto-judge-selection";
import { AutoJudgePicker } from "@/components/settings/panels/auto-judge-picker";

const mockedOpenSettings = vi.hoisted(() => vi.fn());
const mockedHarnesses = [
  {
    id: "claude",
    label: "Claude Code",
    available: true,
    error: null,
    modes: ["gui"],
    requiresApiKey: false,
  },
];
const mockedModels = [
  {
    harnessId: "claude",
    slug: "claude-sonnet",
    label: "Claude Sonnet",
    description: null,
    contextWindow: null,
    maxOutputTokens: null,
    defaultReasoningEffort: null,
    supportedReasoningEfforts: [],
    defaultServiceTier: null,
    supportedServiceTiers: [],
    metadata: {},
  },
];

vi.mock("@/components/home/pickers/harness-model-picker", () => ({
  HarnessModelPicker: () => null,
}));
vi.mock("@/hooks/host/use-host-client-for-host-id", () => ({
  useHostClientForHostId: () => null,
}));
vi.mock("@/hooks/harnesses/use-gui-harness-catalog", () => ({
  useGuiHarnessesQueryForClient: () => ({
    data: {
      harnesses: mockedHarnesses,
    },
  }),
  useGuiHarnessModelsQueryForClient: () => ({
    data: {
      models: mockedModels,
    },
  }),
}));
vi.mock("@/stores/tabs/use-system-tab-modal", () => ({
  useSystemTabModalActions: () => ({ openSettings: mockedOpenSettings }),
}));

afterEach(() => {
  cleanup();
  mockedOpenSettings.mockClear();
});

function harness(overrides: Partial<GuiHarnessOption>): GuiHarnessOption {
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
    const seed = autoJudgeSeed(null, [harness({})], undefined);

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
    const seed = autoJudgeSeed(selection, undefined, undefined);

    expect(seed.seedKey).toBe("loading");
    expect(seed.values.selection).toEqual({
      harnessId: "traycer",
      modelSlug: "",
      profileId: null,
    });
    expect(seed.unrecognizedHarnessId).toBeNull();
  });

  it("seeds the host's effective judge when selection is null", () => {
    const effective: AutoJudgeEffective = {
      harnessId: "claude",
      model: "claude-sonnet",
      source: "default",
    };
    const seed = autoJudgeSeed(null, [harness({})], effective);

    expect(seed.values.selection).toEqual({
      harnessId: "claude",
      modelSlug: "claude-sonnet",
      profileId: null,
    });
    expect(seed.seedKey).toContain("claude-sonnet");
  });

  it("does not let effective metadata replace an explicit stored selection", () => {
    const stored: AutoJudgeSelection = {
      harnessId: "claude",
      model: "stored-model",
      profileId: "profile-1",
    };
    const effective: AutoJudgeEffective = {
      harnessId: "claude",
      model: "effective-model",
      source: "selection",
    };
    const seed = autoJudgeSeed(stored, [harness({})], effective);

    expect(seed.values.selection).toEqual({
      harnessId: "claude",
      modelSlug: "stored-model",
      profileId: "profile-1",
    });
  });

  it("flags a stored harness id absent from the loaded catalog rows", () => {
    const selection: AutoJudgeSelection = {
      harnessId: "some-future-harness",
      model: "some-model",
      profileId: null,
    };
    const seed = autoJudgeSeed(
      selection,
      [harness({ id: "claude" })],
      undefined,
    );

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
    const seed = autoJudgeSeed(
      selection,
      [harness({ id: "claude" })],
      undefined,
    );

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
    expect(
      autoJudgeSeed(null, [harness({})], undefined).storedHarnessLabel,
    ).toBeNull();
    expect(
      autoJudgeSeed(unresolvable, undefined, undefined).storedHarnessLabel,
    ).toBeNull();
    expect(
      autoJudgeSeed(unresolvable, [harness({ id: "claude" })], undefined)
        .storedHarnessLabel,
    ).toBeNull();
  });
});

describe("<AutoJudgePicker /> status", () => {
  const selected: AutoJudgeSelection = {
    harnessId: "claude",
    model: "claude-sonnet",
    profileId: null,
  };

  it("names the effective default using the catalog model label", async () => {
    render(
      createElement(AutoJudgePicker, {
        hostId: "host-a",
        selection: null,
        effective: {
          harnessId: "claude",
          model: "claude-sonnet",
          source: "default",
        },
        blocked: null,
        disabled: false,
        onCommit: vi.fn(),
      }),
    );

    expect(
      (await screen.findByTestId("auto-judge-effective")).textContent,
    ).toBe("Using Traycer's default judge · Claude Sonnet");
  });

  it("shows the legacy default copy when the widened fields are absent", () => {
    render(
      createElement(AutoJudgePicker, {
        hostId: "host-a",
        selection: null,
        effective: undefined,
        blocked: undefined,
        disabled: false,
        onCommit: vi.fn(),
      }),
    );

    expect(screen.getByText("Using Traycer's default judge")).toBeTruthy();
    expect(screen.queryByTestId("auto-judge-effective")).toBeNull();
  });

  it("shows blocked state in amber copy with a Providers fix link", async () => {
    render(
      createElement(AutoJudgePicker, {
        hostId: "host-a",
        selection: selected,
        effective: {
          harnessId: "claude",
          model: "claude-sonnet",
          source: "selection",
        },
        blocked: { reason: "provider-disabled" },
        disabled: false,
        onCommit: vi.fn(),
      }),
    );

    const blocked = await screen.findByTestId("auto-judge-blocked");
    expect(blocked.textContent).toContain(
      "Claude Code is disabled on this machine, so no judge will run.",
    );
    expect(blocked.textContent).toContain(
      "Enable it under Providers, or pick another judge.",
    );
    screen.getByRole("button", { name: "Providers" }).click();
    expect(mockedOpenSettings).toHaveBeenCalledWith({
      section: "providers",
      resetToGeneral: false,
    });
    expect(screen.queryByTestId("auto-judge-effective")).toBeNull();
  });
});
