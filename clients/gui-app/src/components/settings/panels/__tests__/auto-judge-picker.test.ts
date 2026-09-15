import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { useStore } from "zustand";
import type { GuiHarnessOption } from "@traycer/protocol/host/index";
import { guiHarnessOptionSchema } from "@traycer/protocol/host/agent/gui/unary-schemas";
import type {
  AutoJudgeEffective,
  AutoJudgeSelection,
} from "@traycer/protocol/host/auto-mode/contracts";
import {
  autoJudgeRecordHealth,
  autoJudgeSeed,
  autoJudgeSeedKeyForAttempt,
} from "@/components/settings/panels/auto-judge-selection";
import { AutoJudgePicker } from "@/components/settings/panels/auto-judge-picker";
import type { ComposerToolbarStore } from "@/stores/composer/composer-toolbar-store";

const mockedOpenSettings = vi.hoisted(() => vi.fn());
/**
 * The most recent props the mocked `HarnessModelPicker` was rendered with -
 * captured so tests can both assert on what the row passes through
 * (`disabled`) and reach into the real toolbar store it was handed (the
 * rollback test below drives `setSelection` on it directly, standing in for
 * the user's own pick).
 */
let latestHarnessModelPickerProps: {
  readonly store: ComposerToolbarStore;
  readonly disabled: boolean;
} | null = null;
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
  // A second catalog-recognized model, at index 1 so `findDefaultModel`
  // (`models.at(0)`) still resolves the first entry - existing tests that
  // expect "claude-sonnet" everywhere are unaffected. Exists only for the
  // rollback test below, which needs a "diverged" pick the store's own
  // availability-reroute WON'T correct back to the default: an unrecognized
  // slug gets rerouted to the catalog default once it's loaded
  // (`resolveModelSlug`), which would make that test pass even with the
  // rollback logic disabled.
  {
    harnessId: "claude",
    slug: "claude-haiku",
    label: "Claude Haiku",
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

// Renders enough of the real trigger to observe from a test: the current
// `disabled` prop (JOB 1), and - reactively, via `useStore` - the store's
// live selection (JOB 2b's rollback case needs to see the picker present the
// CACHED record after a resetNonce bump, not just at first render).
vi.mock("@/components/home/pickers/harness-model-picker", () => ({
  HarnessModelPicker: (props: {
    readonly store: ComposerToolbarStore;
    readonly disabled: boolean;
  }) => {
    latestHarnessModelPickerProps = props;
    const selection = useStore(props.store, (s) => s.selection);
    return createElement(
      "button",
      {
        type: "button",
        "data-testid": "mocked-harness-model-picker",
        disabled: props.disabled,
      },
      `${selection.harnessId}:${selection.modelSlug}`,
    );
  },
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
  latestHarnessModelPickerProps = null;
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

// JOB 4 + JOB 5: the pure decision `AutoJudgePicker` reads instead of
// computing six interdependent booleans inline. Table-driven because the rule
// IS the precedence between these facts, not any one branch alone.
describe("autoJudgeRecordHealth", () => {
  const BASE = {
    hasStoredSelection: true,
    unrecognizedHarnessId: null as string | null,
    isBlocked: false,
    storedHarnessId: "claude",
    presentedHarnessId: "claude",
    storedModelSlug: "claude-sonnet",
    presentedModelSlug: "claude-sonnet",
    modelsLoaded: true,
  };

  it("no stored selection: everything false", () => {
    const health = autoJudgeRecordHealth({
      ...BASE,
      hasStoredSelection: false,
    });

    expect(health).toEqual({
      storedHarnessUnavailable: false,
      storedModelUnavailable: false,
      noJudgeWillRun: false,
    });
  });

  // `unrecognizedHarnessId` owns this report; every reroute below it would be
  // a CONSEQUENCE of the unrecognized id, not an independent finding - so this
  // function must stay silent and let that line speak alone.
  it("unrecognizedHarnessId set: everything false, even with a harness/model mismatch also present", () => {
    const health = autoJudgeRecordHealth({
      ...BASE,
      unrecognizedHarnessId: "some-future-harness",
      presentedHarnessId: "traycer",
      presentedModelSlug: "",
    });

    expect(health).toEqual({
      storedHarnessUnavailable: false,
      storedModelUnavailable: false,
      noJudgeWillRun: false,
    });
  });

  it("harness reroute (presented differs from stored): storedHarnessUnavailable and noJudgeWillRun, never storedModelUnavailable", () => {
    const health = autoJudgeRecordHealth({
      ...BASE,
      presentedHarnessId: "codex",
      presentedModelSlug: "",
    });

    expect(health).toEqual({
      storedHarnessUnavailable: true,
      storedModelUnavailable: false,
      noJudgeWillRun: true,
    });
  });

  it("model reroute with the harness fine: storedModelUnavailable, and noJudgeWillRun stays false - a model swap still runs a judge", () => {
    const health = autoJudgeRecordHealth({
      ...BASE,
      presentedModelSlug: "claude-haiku",
    });

    expect(health).toEqual({
      storedHarnessUnavailable: false,
      storedModelUnavailable: true,
      noJudgeWillRun: false,
    });
  });

  // Not evidence yet: while the model catalog is still loading the store
  // passes the selection through untouched, so a mismatch here says nothing
  // about availability.
  it("model differs but modelsLoaded is false: storedModelUnavailable stays false", () => {
    const health = autoJudgeRecordHealth({
      ...BASE,
      presentedModelSlug: "claude-haiku",
      modelsLoaded: false,
    });

    expect(health.storedModelUnavailable).toBe(false);
  });

  // `""` is the no-carry seed for an unset record - the store is SUPPOSED to
  // resolve it to the harness default, so a difference there is the feature,
  // not evidence of an unavailable model.
  it("stored slug is the empty no-carry seed: storedModelUnavailable stays false even though presented differs", () => {
    const health = autoJudgeRecordHealth({
      ...BASE,
      storedModelSlug: "",
      presentedModelSlug: "claude-sonnet",
    });

    expect(health.storedModelUnavailable).toBe(false);
  });

  it("isBlocked alone (no reroute): noJudgeWillRun true, both reroute flags stay false", () => {
    const health = autoJudgeRecordHealth({
      ...BASE,
      isBlocked: true,
    });

    expect(health).toEqual({
      storedHarnessUnavailable: false,
      storedModelUnavailable: false,
      noJudgeWillRun: true,
    });
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
        saving: false,
        resetNonce: 0,
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
        saving: false,
        resetNonce: 0,
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
        saving: false,
        resetNonce: 0,
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

// JOB 4: the defect itself - the self-billing warning rendered even when the
// row had just said no judge will run, two adjacent lines contradicting each
// other. Both testids are asserted together on purpose: a fix that only
// suppresses one of them would still leave the contradiction on screen.
describe("<AutoJudgePicker /> suppresses self-billing when no judge will run", () => {
  const selected: AutoJudgeSelection = {
    harnessId: "claude",
    model: "claude-sonnet",
    profileId: null,
  };

  it("blocked: auto-judge-self-billing is absent while auto-judge-blocked is present", async () => {
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
        saving: false,
        resetNonce: 0,
        onCommit: vi.fn(),
      }),
    );

    expect(await screen.findByTestId("auto-judge-blocked")).toBeTruthy();
    expect(screen.queryByTestId("auto-judge-self-billing")).toBeNull();
  });

  it("harness-unavailable: auto-judge-self-billing is absent while auto-judge-unavailable is present", () => {
    // Two rows so the store has somewhere to reroute TO: "claude" is the
    // stored harness and reports itself unavailable, "codex" is the only
    // other eligible one - `effectiveSelectionFromHarnesses` reroutes the
    // presented selection onto it, which is what makes
    // `storedHarnessUnavailable` true.
    // Snapshotted, not restated: the `finally` below used to rebuild the
    // fixture by hand (`length = 1`, `[0].available = true`), which is a
    // restatement of today's initial state and goes quietly wrong the day this
    // file gains a third harness or seeds a different `available`. Deriving the
    // restore from what was actually there cannot drift.
    const originalHarnesses = mockedHarnesses.map((harness) => ({
      ...harness,
    }));
    mockedHarnesses.push({
      id: "codex",
      label: "Codex",
      available: true,
      error: null,
      modes: ["gui"],
      requiresApiKey: false,
    });
    mockedHarnesses[0].available = false;

    try {
      render(
        createElement(AutoJudgePicker, {
          hostId: "host-a",
          selection: selected,
          effective: {
            harnessId: "claude",
            model: "claude-sonnet",
            source: "selection",
          },
          blocked: null,
          disabled: false,
          saving: false,
          resetNonce: 0,
          onCommit: vi.fn(),
        }),
      );

      expect(screen.getByTestId("auto-judge-unavailable")).toBeTruthy();
      expect(screen.queryByTestId("auto-judge-self-billing")).toBeNull();
    } finally {
      mockedHarnesses.length = 0;
      mockedHarnesses.push(...originalHarnesses);
    }
  });
});

// JOB 5: the stored judge MODEL left the catalog while the harness stayed
// fine - before this line existed only the harness reroute was surfaced, so
// this case display-healed silently and the host kept trying a slug that no
// longer exists.
describe("<AutoJudgePicker /> model-unavailable line", () => {
  it("renders and names the stored slug when the store presents a different model than the one stored", () => {
    const storedDifferentModel: AutoJudgeSelection = {
      harnessId: "claude",
      // Not in `mockedModels` ("claude-sonnet" / "claude-haiku") - the
      // catalog reroutes the presented selection to `findDefaultModel`
      // (`.at(0)`, "claude-sonnet"), leaving stored and presented apart.
      model: "claude-opus-retired",
      profileId: null,
    };

    render(
      createElement(AutoJudgePicker, {
        hostId: "host-a",
        selection: storedDifferentModel,
        effective: {
          harnessId: "claude",
          model: "claude-opus-retired",
          source: "selection",
        },
        blocked: null,
        disabled: false,
        saving: false,
        resetNonce: 0,
        onCommit: vi.fn(),
      }),
    );

    const line = screen.getByTestId("auto-judge-model-unavailable");
    expect(line.textContent).toContain("claude-opus-retired");
  });
});

describe("<AutoJudgePicker /> Use Traycer's default", () => {
  const selected: AutoJudgeSelection = {
    harnessId: "claude",
    model: "claude-sonnet",
    profileId: null,
  };

  it("renders the button when there is a stored override, and clicking it commits exactly null - the contract's own CLEAR", () => {
    const onCommit = vi.fn();
    render(
      createElement(AutoJudgePicker, {
        hostId: "host-a",
        selection: selected,
        effective: {
          harnessId: "claude",
          model: "claude-sonnet",
          source: "selection",
        },
        blocked: null,
        disabled: false,
        saving: false,
        resetNonce: 0,
        onCommit,
      }),
    );

    const button = screen.getByTestId("auto-judge-use-default");
    button.click();

    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith(null);
  });

  // Without this, a host already on the catalog default could offer a
  // control that sends the state it is already in - noise the row is
  // specifically written not to show, since it is what keeps a click here
  // from being the trap this button exists to close.
  it("does not render the button when selection is already null - the host is already on the catalog default", () => {
    render(
      createElement(AutoJudgePicker, {
        hostId: "host-a",
        selection: null,
        effective: undefined,
        blocked: undefined,
        disabled: false,
        saving: false,
        resetNonce: 0,
        onCommit: vi.fn(),
      }),
    );

    expect(screen.queryByTestId("auto-judge-use-default")).toBeNull();
  });

  it("disables the button when props.disabled is true", () => {
    render(
      createElement(AutoJudgePicker, {
        hostId: "host-a",
        selection: selected,
        effective: {
          harnessId: "claude",
          model: "claude-sonnet",
          source: "selection",
        },
        blocked: null,
        disabled: true,
        saving: false,
        resetNonce: 0,
        onCommit: vi.fn(),
      }),
    );

    const button = screen.getByTestId(
      "auto-judge-use-default",
    ) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });
});

describe("autoJudgeSeedKeyForAttempt", () => {
  // Nonce 0 is what keeps the store's INITIAL `seedKey` (built from
  // `autoJudgeSeed(...).seedKey` at store creation, before any failure
  // exists) matching the key the layout effect applies on first render - a
  // widened key here would make the very first render re-seed itself.
  it("returns the seed key unchanged for nonce 0", () => {
    const seedKey = "claude\u0000claude-sonnet\u0000";

    expect(autoJudgeSeedKeyForAttempt(seedKey, 0)).toBe(seedKey);
  });

  // Two refusals in a row must each roll the picker back, so nonce 1 and
  // nonce 2 have to differ from each other as well as from the base key -
  // not just "any nonce widens the key once".
  it("produces a distinct key for nonce 1 and nonce 2, both different from the base key", () => {
    const seedKey = "claude\u0000claude-sonnet\u0000";
    const attempt1 = autoJudgeSeedKeyForAttempt(seedKey, 1);
    const attempt2 = autoJudgeSeedKeyForAttempt(seedKey, 2);

    expect(attempt1).not.toBe(seedKey);
    expect(attempt2).not.toBe(seedKey);
    expect(attempt1).not.toBe(attempt2);
  });
});

describe("<AutoJudgePicker /> saving spinner", () => {
  const selected: AutoJudgeSelection = {
    harnessId: "claude",
    model: "claude-sonnet",
    profileId: null,
  };

  // `MutedAgentSpinner` carries neither a `data-testid` (it always passes
  // `testId: undefined`) nor a distinguishing `aria-*` attribute, so - as
  // `harness-model-picker.test.tsx`'s `triggerShowsLoadingSpinner` already
  // established for the same component - its dots-preset span is identified
  // by `.tabular-nums`, the one class unique to that span.
  it("renders the spinner beside the trigger while a write is pending", () => {
    const { container } = render(
      createElement(AutoJudgePicker, {
        hostId: "host-a",
        selection: selected,
        effective: {
          harnessId: "claude",
          model: "claude-sonnet",
          source: "selection",
        },
        blocked: null,
        disabled: true,
        saving: true,
        resetNonce: 0,
        onCommit: vi.fn(),
      }),
    );

    expect(container.querySelector(".tabular-nums")).not.toBeNull();
  });

  // The control: without it, the assertion above could be trivially true
  // because the trigger row always renders something matching - this proves
  // the spinner tracks `saving` rather than being unconditionally present.
  it("renders no spinner when no write is pending", () => {
    const { container } = render(
      createElement(AutoJudgePicker, {
        hostId: "host-a",
        selection: selected,
        effective: {
          harnessId: "claude",
          model: "claude-sonnet",
          source: "selection",
        },
        blocked: null,
        disabled: false,
        saving: false,
        resetNonce: 0,
        onCommit: vi.fn(),
      }),
    );

    expect(container.querySelector(".tabular-nums")).toBeNull();
  });
});

describe("<AutoJudgePicker /> disabled reaches the trigger", () => {
  const selected: AutoJudgeSelection = {
    harnessId: "claude",
    model: "claude-sonnet",
    profileId: null,
  };

  // The mutation scope already serializes the REQUESTS; this is the row's
  // other half - locking the control itself so a second pick can't queue
  // behind the first and later get its selection silently overwritten when
  // the first write's success reseeds the picker. Asserted on the mocked
  // `HarnessModelPicker`'s own `disabled` prop, not a DOM side effect of it,
  // since the mock renders `null` from the real component.
  it("passes disabled: true through to HarnessModelPicker while a write is pending", () => {
    render(
      createElement(AutoJudgePicker, {
        hostId: "host-a",
        selection: selected,
        effective: {
          harnessId: "claude",
          model: "claude-sonnet",
          source: "selection",
        },
        blocked: null,
        disabled: true,
        saving: true,
        resetNonce: 0,
        onCommit: vi.fn(),
      }),
    );

    const trigger = screen.getByTestId(
      "mocked-harness-model-picker",
    ) as HTMLButtonElement;
    expect(trigger.disabled).toBe(true);
  });

  // Control: the same assertion with `disabled: false`, so a suite that
  // always saw `disabled: true` (a picker that ignores the prop and hardcodes
  // it) could not pass both.
  it("passes disabled: false through to HarnessModelPicker at rest", () => {
    render(
      createElement(AutoJudgePicker, {
        hostId: "host-a",
        selection: selected,
        effective: {
          harnessId: "claude",
          model: "claude-sonnet",
          source: "selection",
        },
        blocked: null,
        disabled: false,
        saving: false,
        resetNonce: 0,
        onCommit: vi.fn(),
      }),
    );

    const trigger = screen.getByTestId(
      "mocked-harness-model-picker",
    ) as HTMLButtonElement;
    expect(trigger.disabled).toBe(false);
  });
});

describe("<AutoJudgePicker /> rollback on refused write", () => {
  const cached: AutoJudgeSelection = {
    harnessId: "claude",
    model: "claude-sonnet",
    profileId: null,
  };
  const effective: AutoJudgeEffective = {
    harnessId: "claude",
    model: "claude-sonnet",
    source: "selection",
  };

  function renderPicker(resetNonce: number) {
    return render(
      createElement(AutoJudgePicker, {
        hostId: "host-a",
        selection: cached,
        effective,
        blocked: null,
        disabled: false,
        saving: false,
        resetNonce,
        onCommit: vi.fn(),
      }),
    );
  }

  // The behavioural case JOB 2 exists for. `applySeed` early-returns on a
  // matching seed key, which is exactly what strands the picker after a
  // refused write: the cache never moved, so without the nonce the seed key
  // wouldn't move either and the user's (rejected) pick would sit there
  // presented as current. Bumping `resetNonce` on refusal must force the
  // cached record back onto the trigger.
  //
  // FALSIFICATION: change `autoJudgeSeedKeyForAttempt` to `return seedKey;`
  // (ignoring the nonce) - this test goes red, because the bumped-nonce
  // re-render then hits the exact same early return and the diverged pick
  // stays on screen. Verified by hand; see the report back to the assigning
  // agent for the red output.
  it("re-applies the cached selection once resetNonce bumps, discarding a diverged in-flight pick", () => {
    const { rerender } = renderPicker(0);

    expect(screen.getByTestId("mocked-harness-model-picker").textContent).toBe(
      "claude:claude-sonnet",
    );

    // Stand in for the user's own pick, made through the real
    // `HarnessModelPicker` while a write for it is in flight and gets
    // refused - the store adopts it immediately, same as the real trigger's
    // commit path.
    act(() => {
      latestHarnessModelPickerProps?.store.getState().setSelection({
        harnessId: "claude",
        modelSlug: "claude-haiku",
        profileId: null,
      });
    });
    expect(screen.getByTestId("mocked-harness-model-picker").textContent).toBe(
      "claude:claude-haiku",
    );

    // The row bumps `resetNonce` on refusal (`setRefusedWrites`); `selection`
    // itself is unchanged, since the cache never moved.
    rerender(
      createElement(AutoJudgePicker, {
        hostId: "host-a",
        selection: cached,
        effective,
        blocked: null,
        disabled: false,
        saving: false,
        resetNonce: 1,
        onCommit: vi.fn(),
      }),
    );

    expect(screen.getByTestId("mocked-harness-model-picker").textContent).toBe(
      "claude:claude-sonnet",
    );
  });
});
