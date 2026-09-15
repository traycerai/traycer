import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import type {
  AgentReasoningEffortOption,
  GuiAgentModelOption,
} from "@traycer/protocol/host/index";
import type {
  TierCandidate,
  TierCandidatePreview,
} from "@traycer/protocol/host/fallback-policy";
import {
  FallbackTierGroupCard,
  type FallbackTierGroupCardProps,
} from "@/components/settings/panels/fallback/fallback-tier-group-card";
import {
  keyedGroup,
  type FallbackGroupsInverse,
  type KeyedGroup,
} from "@/components/settings/panels/fallback/fallback-tier-group-keys";
import type { FallbackSettingsProfileLabel } from "@/components/settings/panels/fallback/fallback-profile-labels";
import {
  catalogModelForFamily,
  type FallbackCatalogOptions,
} from "@/components/settings/panels/fallback/fallback-catalog-options";
import { harnessLabel } from "@/components/settings/panels/fallback/fallback-harness-label";

const { toastSuccess } = vi.hoisted(() => ({
  toastSuccess: vi.fn<
    (
      message: string,
      options: {
        readonly action: {
          readonly label: string;
          readonly onClick: () => void;
        };
      },
    ) => void
  >(),
}));

vi.mock("sonner", () => ({
  toast: {
    success: toastSuccess,
    error: vi.fn(),
    info: vi.fn(),
    message: vi.fn(),
  },
}));

// `globals: false` in vitest.config.ts means RTL's automatic cleanup never
// registers - every suite that renders must call this itself.
afterEach(() => {
  cleanup();
});

const LABEL_FOR: FallbackSettingsProfileLabel = (profileId) => profileId;

function candidate(
  harnessId: TierCandidate["harnessId"],
  modelFamily: string,
  reasoningEffort: string | null,
): TierCandidate {
  return { harnessId, modelFamily, reasoningEffort };
}

function effort(id: string, label: string): AgentReasoningEffortOption {
  return { id, label, description: null };
}

function model(
  harnessId: GuiAgentModelOption["harnessId"],
  slug: string,
  label: string,
  supportedReasoningEfforts: readonly AgentReasoningEffortOption[],
): GuiAgentModelOption {
  return {
    harnessId,
    slug,
    label,
    description: null,
    contextWindow: null,
    maxOutputTokens: null,
    defaultReasoningEffort: null,
    supportedReasoningEfforts: [...supportedReasoningEfforts],
    defaultServiceTier: null,
    supportedServiceTiers: [],
    metadata: {},
  };
}

/** No catalog for any harness - the "no answer" state every gated read can be in. */
function emptyCatalog(): FallbackCatalogOptions {
  return {
    modelsFor: () => [],
    effortsFor: () => [],
  };
}

/**
 * A catalog fixture built the same way the real `useFallbackCatalogOptions`
 * hook resolves `effortsFor`: one model's own levels when `modelFamily` names
 * it exactly, the dedup union across the harness's models otherwise. Reusing
 * `catalogModelForFamily` (the production pure helper) rather than
 * reimplementing the match keeps this fixture's semantics from silently
 * drifting from what the hook actually returns.
 */
function catalogFixture(
  byHarness: ReadonlyMap<
    TierCandidate["harnessId"],
    readonly GuiAgentModelOption[]
  >,
): FallbackCatalogOptions {
  return {
    modelsFor: (harnessId) => byHarness.get(harnessId) ?? [],
    effortsFor: (harnessId, modelFamily) => {
      const models = byHarness.get(harnessId) ?? [];
      const picked = catalogModelForFamily(models, modelFamily);
      if (picked !== null) return picked.supportedReasoningEfforts;
      const seen = new Map<string, AgentReasoningEffortOption>();
      for (const found of models) {
        for (const option of found.supportedReasoningEfforts) {
          if (!seen.has(option.id)) seen.set(option.id, option);
        }
      }
      return [...seen.values()];
    },
  };
}

/**
 * Every prop `FallbackTierGroupCard` requires, with the mocks typed as
 * `Mock<...>` (rather than the prop interface's plain function type) so a
 * test can read `.mock.calls` straight off the object this returns with no
 * cast - `Mock<Fn>` is a valid substitute for `Fn` wherever the component
 * consumes it as a prop.
 */
interface CardTestProps {
  readonly group: KeyedGroup;
  readonly isDefault: boolean;
  readonly preview: readonly TierCandidatePreview[] | null;
  readonly labelFor: FallbackSettingsProfileLabel;
  readonly catalog: FallbackCatalogOptions;
  readonly onChange: Mock<(next: KeyedGroup) => void>;
  readonly onCommit: Mock<(next: KeyedGroup) => void>;
  readonly onDelete: Mock<() => void>;
  readonly onUndo: Mock<(inverse: FallbackGroupsInverse) => void>;
  readonly defaultHarnessId: TierCandidate["harnessId"];
}

function baseCardProps(candidates: readonly TierCandidate[]): CardTestProps {
  return {
    group: keyedGroup({ id: "fast", candidates: [...candidates] }),
    isDefault: false,
    preview: null,
    labelFor: LABEL_FOR,
    catalog: emptyCatalog(),
    onChange: vi.fn(),
    onCommit: vi.fn(),
    onDelete: vi.fn(),
    onUndo: vi.fn(),
    defaultHarnessId: "claude",
  };
}

function renderCard(props: CardTestProps): void {
  const cardProps: FallbackTierGroupCardProps = props;
  render(<FallbackTierGroupCard {...cardProps} />);
}

function preview(overrides: {
  readonly candidateIndex: number;
  readonly modelFamily: string;
  readonly resolvedModel: string | null;
  readonly profileId: string | null;
  readonly skipReason: string | null;
  readonly skipLabel: string | null;
  readonly warnings: readonly string[];
}): TierCandidatePreview {
  return {
    groupId: "fast",
    harnessId: "claude",
    reasoningEffort: null,
    ...overrides,
    warnings: [...overrides.warnings],
  };
}

/** Radix's select: open with the keyboard. */
function openSelect(trigger: HTMLElement): void {
  fireEvent.keyDown(trigger, { key: "ArrowDown" });
}

/** Commit the named option; Radix closes its own portal on this keydown. */
function chooseOption(name: string): void {
  const item = screen.getByRole("option", { name });
  fireEvent.focus(item);
  fireEvent.keyDown(item, { key: "Enter" });
}

/**
 * The native `disabled` property, not `toBeDisabled()`: jest-dom's matchers
 * are not wired into this suite, so the matcher would be undefined rather
 * than failing informatively.
 */
function isDisabled(element: HTMLElement): boolean {
  return element instanceof HTMLButtonElement && element.disabled;
}

describe("FallbackTierGroupCard - group container, default badge", () => {
  it("a named group renders role=group with 'Model group <id>'", () => {
    renderCard(baseCardProps([candidate("claude", "opus", null)]));
    // Falsification: drop `aria-label={groupContainerLabel(group.id)}` from
    // the card's outer `<div role="group">` - this query would then find
    // nothing.
    expect(
      screen.getByRole("group", { name: "Model group fast" }),
    ).not.toBeNull();
  });

  it("a blank-name group renders role=group with 'Unnamed model group', not a position", () => {
    const props = baseCardProps([]);
    renderCard({ ...props, group: keyedGroup({ id: "", candidates: [] }) });
    expect(
      screen.getByRole("group", { name: "Unnamed model group" }),
    ).not.toBeNull();
  });

  it("renders the Default badge exactly when isDefault is true", () => {
    const props = baseCardProps([candidate("claude", "opus", null)]);
    renderCard({ ...props, isDefault: true });
    // Falsification: render the badge unconditionally (or never) - this
    // would pass with `isDefault: false` too, or fail to appear here.
    expect(screen.getByTestId("fallback-tier-group-default").textContent).toBe(
      "Default",
    );
  });

  it("renders NO Default badge when isDefault is false", () => {
    const props = baseCardProps([candidate("claude", "opus", null)]);
    renderCard({ ...props, isDefault: false });
    expect(screen.queryByTestId("fallback-tier-group-default")).toBeNull();
  });
});

describe("FallbackTierGroupCard - AX8: candidate rows disambiguate by position, nested inside their group", () => {
  it("two groups on screen, one with two rows: each row's Model combobox resolves to exactly one element within its own named row", () => {
    const fast = keyedGroup({
      id: "fast",
      candidates: [
        candidate("claude", "opus", null),
        candidate("claude", "sonnet", null),
      ],
    });
    const slow = keyedGroup({
      id: "slow",
      candidates: [candidate("claude", "haiku", null)],
    });
    const shared = baseCardProps([]);
    render(
      <>
        <FallbackTierGroupCard {...shared} group={fast} />
        <FallbackTierGroupCard {...shared} group={slow} />
      </>,
    );

    // The GROUP is disambiguated by its own accessible name...
    const fastGroup = screen.getByRole("group", { name: "Model group fast" });
    // ...and the ROW within it, by position - "Model" alone is not unique
    // across four rows total (two in "fast"), so the row container is what
    // makes `within(row)` resolve to exactly one field.
    //
    // Falsification: drop `aria-label={`Model ${index + 1}`}` from
    // `CandidateRow`'s own container - `within(fastGroup).getByRole("group",
    // {name: "Model 2"})` would then throw, since nothing distinguishes the
    // two rows from each other.
    const secondRow = within(fastGroup).getByRole("group", { name: "Model 2" });
    expect(
      within(secondRow).getByRole("combobox", { name: "Model" }),
    ).not.toBeNull();

    const firstRow = within(fastGroup).getByRole("group", { name: "Model 1" });
    expect(
      within(firstRow).getByRole("combobox", { name: "Model" }),
    ).not.toBeNull();
  });
});

describe("FallbackTierGroupCard - Model select: catalog rendering", () => {
  it("a stored slug that matches a catalog model renders that model and no pinned item", () => {
    const models = new Map([
      [
        "claude" as const,
        [
          model("claude", "claude-opus-5", "Claude Opus 5", []),
          model("claude", "claude-sonnet-5", "Claude Sonnet 5", []),
        ],
      ],
    ]);
    const props = baseCardProps([candidate("claude", "claude-opus-5", null)]);
    renderCard({ ...props, catalog: catalogFixture(models) });
    openSelect(screen.getByRole("combobox", { name: "Model" }));
    // Falsification: keep pinning the stored value even when it IS a catalog
    // slug - a `fallback-model-pinned` item would then render alongside the
    // catalog's own "Claude Opus 5" item.
    expect(screen.queryByTestId("fallback-model-pinned")).toBeNull();
    expect(
      screen.getByRole("option", { name: "Claude Opus 5" }),
    ).not.toBeNull();
    expect(
      screen.getByRole("option", { name: "Claude Sonnet 5" }),
    ).not.toBeNull();
  });

  it("a stored family that matches no catalog slug is pinned, tagged 'family' ONLY when the catalog is non-empty", () => {
    const models = new Map([
      [
        "claude" as const,
        [model("claude", "claude-opus-5", "Claude Opus 5", [])],
      ],
    ]);
    const props = baseCardProps([candidate("claude", "opus", null)]);
    renderCard({ ...props, catalog: catalogFixture(models) });
    openSelect(screen.getByRole("combobox", { name: "Model" }));
    // Falsification: drop the pinned range-render entirely - a family value
    // like "opus" would then vanish from the Select instead of showing what
    // is actually saved.
    expect(screen.getByTestId("fallback-model-pinned").textContent).toContain(
      "opus",
    );
    // Falsification: tag every pinned value "family" regardless of whether
    // there is a catalog to contrast it against - `taggedFamily` is
    // `pinned && models.length > 0`, not `pinned` alone.
    //
    // Scoped to the open listbox: the Badge's text is also portaled into the
    // closed trigger's own value node as the CURRENT selection (Radix's
    // `SelectItemText` mechanism, documented on `Select` in `ui/select.tsx`),
    // so an unscoped query would find two matching nodes.
    expect(
      within(screen.getByRole("listbox")).getByTestId(
        "fallback-model-family-tag",
      ).textContent,
    ).toBe("family");
  });

  it("a stored family is still pinned but carries NO 'family' tag when the harness's catalog is empty", () => {
    const props = baseCardProps([candidate("claude", "opus", null)]);
    renderCard({ ...props, catalog: emptyCatalog() });
    openSelect(screen.getByRole("combobox", { name: "Model" }));
    expect(screen.getByTestId("fallback-model-pinned").textContent).toContain(
      "opus",
    );
    // Falsification: tag the pinned value whenever it is pinned, dropping the
    // `models.length > 0` half of `taggedFamily` - the tag would then appear
    // with nothing on the menu to contrast it against.
    expect(screen.queryByTestId("fallback-model-family-tag")).toBeNull();
  });

  it("an empty catalog with a blank stored value shows the disabled 'No models to choose from' placeholder", () => {
    const props = baseCardProps([candidate("claude", "", null)]);
    renderCard({ ...props, catalog: emptyCatalog() });
    openSelect(screen.getByRole("combobox", { name: "Model" }));
    // Falsification: render nothing in the menu instead of the disabled
    // placeholder - an empty menu reads as broken, with no way to tell a
    // cold catalog from a rendering bug.
    const placeholder = screen.getByRole("option", {
      name: "No models to choose from",
    });
    expect(placeholder.getAttribute("aria-disabled")).toBe("true");
  });

  it("a blank stored family carries aria-invalid on the Model trigger; a filled one does not", () => {
    const props = baseCardProps([
      candidate("claude", "", null),
      candidate("claude", "opus", null),
    ]);
    renderCard(props);
    const [blank, filled] = screen.getAllByRole("combobox", { name: "Model" });
    // Falsification: drop the `aria-invalid={stored === "" ? true :
    // undefined}` ternary on the trigger, or invert its condition.
    expect(blank.getAttribute("aria-invalid")).toBe("true");
    expect(filled.getAttribute("aria-invalid")).toBeNull();
  });
});

describe("FallbackTierGroupCard - Model select: commit behavior", () => {
  it("picking a catalog model commits the new slug and CLEARS an effort the new model does not offer", () => {
    const models = new Map([
      [
        "claude" as const,
        [
          model("claude", "opus", "Opus", [
            effort("high", "High"),
            effort("low", "Low"),
          ]),
          model("claude", "sonnet", "Sonnet", [effort("medium", "Medium")]),
        ],
      ],
    ]);
    const props = baseCardProps([candidate("claude", "opus", "low")]);
    renderCard({ ...props, catalog: catalogFixture(models) });
    openSelect(screen.getByRole("combobox", { name: "Model" }));
    chooseOption("Sonnet");
    // Falsification: keep the old effort id on the new model regardless of
    // whether it offers it - "low" would then survive onto "sonnet", which
    // does not support it, and the engine would drop it silently at
    // resolution.
    expect(props.onCommit).toHaveBeenCalledTimes(1);
    expect(props.onCommit.mock.calls[0][0].candidates[0].value).toEqual({
      harnessId: "claude",
      modelFamily: "sonnet",
      reasoningEffort: null,
    });
    // The draft/uncommitted callback is never touched by a Select.
    expect(props.onChange).not.toHaveBeenCalled();
  });

  it("picking a catalog model commits the new slug and KEEPS an effort the new model still offers", () => {
    const models = new Map([
      [
        "claude" as const,
        [
          model("claude", "opus", "Opus", [
            effort("high", "High"),
            effort("low", "Low"),
          ]),
          model("claude", "sonnet", "Sonnet", [
            effort("low", "Low"),
            effort("medium", "Medium"),
          ]),
        ],
      ],
    ]);
    const props = baseCardProps([candidate("claude", "opus", "low")]);
    renderCard({ ...props, catalog: catalogFixture(models) });
    openSelect(screen.getByRole("combobox", { name: "Model" }));
    chooseOption("Sonnet");
    // Falsification: clear the effort on every model change regardless of
    // whether the new model still offers it - a user who picked a sibling
    // model at the same level would lose their choice for no reason.
    expect(props.onCommit.mock.calls[0][0].candidates[0].value).toEqual({
      harnessId: "claude",
      modelFamily: "sonnet",
      reasoningEffort: "low",
    });
  });
});

describe("FallbackTierGroupCard - Provider select", () => {
  it("lists the GUI-capable harnesses by their display label", () => {
    const props = baseCardProps([candidate("claude", "opus", null)]);
    renderCard(props);
    openSelect(screen.getByRole("combobox", { name: "Provider" }));
    expect(
      screen.getByRole("option", { name: harnessLabel("codex") }),
    ).not.toBeNull();
    expect(
      screen.getByRole("option", { name: harnessLabel("claude") }),
    ).not.toBeNull();
  });

  it("changing the provider clears both model and effort in ONE commit", () => {
    const props = baseCardProps([candidate("claude", "opus", "high")]);
    renderCard(props);
    openSelect(screen.getByRole("combobox", { name: "Provider" }));
    chooseOption(harnessLabel("codex"));
    // Falsification: commit the harness change alone and leave modelFamily /
    // reasoningEffort untouched - "high" and "opus" would then survive onto
    // codex, whose catalog the engine can never match them against.
    expect(props.onCommit).toHaveBeenCalledTimes(1);
    expect(props.onCommit.mock.calls[0][0].candidates[0].value).toEqual({
      harnessId: "codex",
      modelFamily: "",
      reasoningEffort: null,
    });
    expect(props.onChange).not.toHaveBeenCalled();
  });
});

describe("FallbackTierGroupCard - Effort select", () => {
  it("offers exactly the effort list catalog.effortsFor returns, in that order - not a hardcoded list", () => {
    const offered = [
      effort("z-level", "Z Level"),
      effort("a-level", "A Level"),
    ];
    const effortsFor: Mock<
      (
        harnessId: TierCandidate["harnessId"],
        modelFamily: string,
      ) => readonly AgentReasoningEffortOption[]
    > = vi.fn(() => offered);
    const catalog: FallbackCatalogOptions = { modelsFor: () => [], effortsFor };
    const props = baseCardProps([candidate("claude", "gpt-5", null)]);
    renderCard({ ...props, catalog });
    openSelect(screen.getByRole("combobox", { name: "Effort" }));
    // Falsification: render a fixed/static Effort menu (e.g. always
    // high/medium/low) instead of mapping `catalog.effortsFor(...)` - this
    // would keep passing with a plausible-looking list unrelated to what the
    // fixture actually returned.
    expect(
      screen.getAllByRole("option").map((option) => option.textContent),
    ).toEqual(["Any effort", "Z Level", "A Level"]);
    expect(effortsFor).toHaveBeenCalledWith("claude", "gpt-5");
  });

  it("is disabled with zero offered options and a null stored value, but stays enabled once a value is stored", () => {
    const props = baseCardProps([
      candidate("claude", "gpt-5", null),
      candidate("claude", "gpt-5", "custom-level"),
    ]);
    renderCard({ ...props, catalog: emptyCatalog() });
    const [nullRowEffort, storedRowEffort] = screen.getAllByRole("combobox", {
      name: "Effort",
    });
    // Falsification: disable the Select whenever it has zero offered
    // options, dropping the `stored === null` half of the guard - the second
    // row would then lose the one edit still possible on it: clearing a
    // stored value nothing supports any more.
    expect(isDisabled(nullRowEffort)).toBe(true);
    expect(isDisabled(storedRowEffort)).toBe(false);
  });

  it("a stored effort outside the offered set renders as its own 'not offered here' item", () => {
    const props = baseCardProps([candidate("claude", "gpt-5", "custom-level")]);
    renderCard({ ...props, catalog: emptyCatalog() });
    openSelect(screen.getByRole("combobox", { name: "Effort" }));
    expect(screen.getByTestId("fallback-effort-unsupported").textContent).toBe(
      "custom-level - not offered here",
    );
  });

  it("choosing 'Any effort' commits null; choosing an offered level commits its id", () => {
    const models = new Map([
      [
        "claude" as const,
        [model("claude", "opus", "Opus", [effort("high", "High")])],
      ],
    ]);
    const props = baseCardProps([candidate("claude", "opus", "high")]);
    renderCard({ ...props, catalog: catalogFixture(models) });
    openSelect(screen.getByRole("combobox", { name: "Effort" }));
    chooseOption("Any effort");
    expect(props.onCommit.mock.calls[0][0].candidates[0].value).toEqual({
      harnessId: "claude",
      modelFamily: "opus",
      reasoningEffort: null,
    });
    expect(props.onChange).not.toHaveBeenCalled();
  });
});

describe("FallbackTierGroupCard - Remove: accessible name and toast both name the model the same way", () => {
  it("names a blank row 'model' in both the button and the toast", () => {
    const props = baseCardProps([candidate("claude", "", null)]);
    renderCard(props);
    fireEvent.click(screen.getByRole("button", { name: "Remove model" }));
    expect(toastSuccess).toHaveBeenCalledWith(
      "Removed the empty row",
      expect.anything(),
    );
  });

  it("names a known catalog slug by its catalog LABEL in both the button and the toast", () => {
    const models = new Map([
      [
        "claude" as const,
        [model("claude", "claude-opus-5", "Claude Opus 5", [])],
      ],
    ]);
    const props = baseCardProps([candidate("claude", "claude-opus-5", null)]);
    renderCard({ ...props, catalog: catalogFixture(models) });
    // Falsification: name the button/toast by the raw stored slug instead of
    // `candidateDisplayName`'s catalog lookup - "Remove claude-opus-5" would
    // render instead of the human label a user actually recognizes.
    fireEvent.click(
      screen.getByRole("button", { name: "Remove Claude Opus 5" }),
    );
    expect(toastSuccess).toHaveBeenCalledWith(
      "Removed “Claude Opus 5”",
      expect.anything(),
    );
  });

  it("names a family that matches no catalog slug by the raw stored value in both the button and the toast", () => {
    const props = baseCardProps([candidate("claude", "opus", null)]);
    renderCard({ ...props, catalog: emptyCatalog() });
    fireEvent.click(screen.getByRole("button", { name: "Remove opus" }));
    expect(toastSuccess).toHaveBeenCalledWith(
      "Removed “opus”",
      expect.anything(),
    );
  });
});

describe("FallbackTierGroupCard - preview verdict line", () => {
  it("resolvedModel null, family-unmatched: red/data-unmatched with skipLabel and warnings", () => {
    const props = baseCardProps([candidate("claude", "gpt-9", null)]);
    renderCard({
      ...props,
      preview: [
        preview({
          candidateIndex: 0,
          modelFamily: "gpt-9",
          resolvedModel: null,
          profileId: null,
          skipReason: "family-unmatched",
          skipLabel: "No match",
          warnings: ["low balance"],
        }),
      ],
    });
    const line = screen.getByTestId("fallback-tier-candidate-preview");
    // Falsification: color every skip red instead of gating on
    // `skipReason === "family-unmatched"` - an environmental skip (a
    // provider outage) would then look like the user's own authoring error.
    expect(line.getAttribute("data-unmatched")).toBe("true");
    expect(line.textContent).toBe("No match - low balance");
  });

  it("resolvedModel null, a non-unmatched reason: not colored red, falls back to 'not available' with no skipLabel", () => {
    const props = baseCardProps([candidate("claude", "gpt-9", null)]);
    renderCard({
      ...props,
      preview: [
        preview({
          candidateIndex: 0,
          modelFamily: "gpt-9",
          resolvedModel: null,
          profileId: null,
          skipReason: "provider-unavailable",
          skipLabel: null,
          warnings: [],
        }),
      ],
    });
    const line = screen.getByTestId("fallback-tier-candidate-preview");
    expect(line.getAttribute("data-unmatched")).toBeNull();
    expect(line.textContent).toBe("not available");
  });

  it("resolvedModel differs from the stored family: 'matches <label> today on <account>' plus warnings", () => {
    const models = new Map([
      [
        "claude" as const,
        [model("claude", "claude-sonnet-5", "Claude Sonnet 5", [])],
      ],
    ]);
    const props = baseCardProps([candidate("claude", "opus", null)]);
    renderCard({
      ...props,
      catalog: catalogFixture(models),
      preview: [
        preview({
          candidateIndex: 0,
          modelFamily: "opus",
          resolvedModel: "claude-sonnet-5",
          profileId: "acct-1",
          skipReason: null,
          skipLabel: null,
          warnings: ["rate limited earlier"],
        }),
      ],
    });
    // Falsification: skip the catalog lookup and print the raw resolved slug
    // even when the catalog knows its label - "matches claude-sonnet-5
    // today" would render instead of the human-readable name.
    expect(
      screen.getByTestId("fallback-tier-candidate-preview").textContent,
    ).toBe("matches Claude Sonnet 5 today on acct-1 - rate limited earlier");
  });

  it("resolvedModel equals the stored value case-insensitively, with warnings: just the warnings, no 'matches' prefix", () => {
    const props = baseCardProps([candidate("claude", "OPUS", null)]);
    renderCard({
      ...props,
      preview: [
        preview({
          candidateIndex: 0,
          modelFamily: "OPUS",
          resolvedModel: "opus",
          profileId: null,
          skipReason: null,
          skipLabel: null,
          warnings: ["rate limited earlier"],
        }),
      ],
    });
    // Falsification: keep the "matches ... today" prefix even when the row
    // already names this model - that reads as noise repeating what the
    // Model cell already shows.
    expect(
      screen.getByTestId("fallback-tier-candidate-preview").textContent,
    ).toBe("rate limited earlier");
  });

  it("resolvedModel equals the stored value with no warnings: no line at all, no aria-describedby", () => {
    const props = baseCardProps([candidate("claude", "opus", null)]);
    renderCard({
      ...props,
      preview: [
        preview({
          candidateIndex: 0,
          modelFamily: "opus",
          resolvedModel: "opus",
          profileId: null,
          skipReason: null,
          skipLabel: null,
          warnings: [],
        }),
      ],
    });
    // Falsification: always point `aria-describedby` at the preview id even
    // when nothing is informative enough to render - a dangling reference to
    // an element that does not exist, which D159 treats as worse than no
    // description at all.
    expect(screen.queryByTestId("fallback-tier-candidate-preview")).toBeNull();
    expect(
      screen
        .getByRole("combobox", { name: "Model" })
        .getAttribute("aria-describedby"),
    ).toBeNull();
  });
});
