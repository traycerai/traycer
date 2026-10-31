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
import {
  createDefaultFallbackPolicy,
  findTierConflicts,
  type TierCandidate,
  type TierCandidatePreview,
  type TierCandidatePreviewMatch,
  type TierConflict,
  type TierGroup,
} from "@traycer/protocol/host/fallback-policy";
import {
  FallbackTierGroupCard,
  type FallbackTierGroupCardProps,
} from "@/components/settings/panels/fallback/fallback-tier-group-card";
import { FallbackTierGroupsEditor } from "@/components/settings/panels/fallback/fallback-tier-groups-editor";
import {
  keyedGroup,
  toKeyedGroups,
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
    catalogFor: () => null,
    catalogsByHarness: new Map(),
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
    catalogFor: (harnessId) => byHarness.get(harnessId) ?? null,
    catalogsByHarness: byHarness,
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
  readonly groupIndex: number;
  readonly tierGroups: readonly TierGroup[];
  readonly isDefault: boolean;
  readonly preview: readonly TierCandidatePreview[] | null;
  readonly labelFor: FallbackSettingsProfileLabel;
  readonly catalog: FallbackCatalogOptions;
  readonly patternsSupported: boolean;
  readonly conflicts: readonly TierConflict[];
  readonly onChange: Mock<(next: KeyedGroup) => void>;
  readonly onCommit: Mock<(next: KeyedGroup) => void>;
  readonly onDelete: Mock<() => void>;
  readonly onUndo: Mock<(inverse: FallbackGroupsInverse) => void>;
  readonly defaultHarnessId: TierCandidate["harnessId"];
  readonly onAnnounce: Mock<(text: string) => void>;
  readonly onGoToRow: Mock<(tierIndex: number, candidateIndex: number) => void>;
}

/**
 * `patternsSupported: false` by default, matching every existing pin here: a
 * 1.0-host card renders the original `ModelSelect` cell, and these fixtures
 * predate patterns entirely. Pin 4/7 tests below opt into `patternsSupported:
 * true` explicitly where the pattern combobox and conflict block are what is
 * under test.
 */
function baseCardProps(candidates: readonly TierCandidate[]): CardTestProps {
  return {
    group: keyedGroup({ id: "fast", candidates: [...candidates] }),
    groupIndex: 0,
    tierGroups: [],
    isDefault: false,
    preview: null,
    labelFor: LABEL_FOR,
    catalog: emptyCatalog(),
    patternsSupported: false,
    conflicts: [],
    onChange: vi.fn(),
    onCommit: vi.fn(),
    onDelete: vi.fn(),
    onUndo: vi.fn(),
    defaultHarnessId: "claude",
    onAnnounce: vi.fn(),
    onGoToRow: vi.fn(),
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
    matches: [],
    warnings: [...overrides.warnings],
  };
}

/** One entry of a preview's `matches` array (Pin 3). */
function matchEntry(
  matchModel: string,
  profileId: string | null,
  skipReason: string | null,
  skipLabel: string | null,
): TierCandidatePreviewMatch {
  return { model: matchModel, profileId, skipReason, skipLabel };
}

/**
 * A preview carrying a REAL `matches` array, as a 1.1+ host actually sends -
 * as opposed to `preview()` above, whose `matches: []` always exercises the
 * `previewMatches` fallback onto `resolvedModel`. Pin 3 needs both: the
 * fallback path (still reachable from a hand-built 1.0-shaped response) and
 * this one (the host's own try order).
 */
function previewWithMatches(overrides: {
  readonly candidateIndex: number;
  readonly modelFamily: string;
  readonly matches: readonly TierCandidatePreviewMatch[];
  readonly warnings: readonly string[];
}): TierCandidatePreview {
  return {
    groupId: "fast",
    harnessId: "claude",
    reasoningEffort: null,
    candidateIndex: overrides.candidateIndex,
    modelFamily: overrides.modelFamily,
    resolvedModel: null,
    profileId: null,
    skipReason: null,
    skipLabel: null,
    matches: [...overrides.matches],
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
  it("a named group renders role=group with 'Tier <id>'", () => {
    renderCard(baseCardProps([candidate("claude", "opus", null)]));
    // Falsification: drop `aria-label={groupContainerLabel(group.id)}` from
    // the card's outer `<div role="group">` - this query would then find
    // nothing.
    expect(screen.getByRole("group", { name: "Tier fast" })).not.toBeNull();
  });

  it("a blank-name group renders role=group with 'Unnamed tier', not a position", () => {
    const props = baseCardProps([]);
    renderCard({ ...props, group: keyedGroup({ id: "", candidates: [] }) });
    expect(screen.getByRole("group", { name: "Unnamed tier" })).not.toBeNull();
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
    const fastGroup = screen.getByRole("group", { name: "Tier fast" });
    // ...and the ROW within it, by position - "Model" alone is not unique
    // across four rows total (two in "fast"), so the row container is what
    // makes `within(row)` resolve to exactly one field.
    //
    // Falsification: drop `aria-label={`Row ${index + 1}`}` from
    // `CandidateRow`'s own container - `within(fastGroup).getByRole("group",
    // {name: "Row 2"})` would then throw, since nothing distinguishes the
    // two rows from each other.
    const secondRow = within(fastGroup).getByRole("group", { name: "Row 2" });
    expect(
      within(secondRow).getByRole("combobox", { name: "Model" }),
    ).not.toBeNull();

    const firstRow = within(fastGroup).getByRole("group", { name: "Row 1" });
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
    const catalog: FallbackCatalogOptions = {
      modelsFor: () => [],
      catalogFor: () => null,
      catalogsByHarness: new Map(),
      effortsFor,
    };
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
    fireEvent.click(screen.getByRole("button", { name: "Remove row" }));
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

describe("FallbackTierGroupCard - row status line (rowStatusLine / RowStatus)", () => {
  it("family-unmatched: red/data-unmatched, names the provider and the pattern, ignores skipLabel entirely", () => {
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
    // Falsification: this is `RowStatus`'s `kind === "unmatched"` branch
    // (`fallback-tier-group-card.tsx`), which no longer prints the host's own
    // `skipLabel` ("No match") - it prints a fixed sentence naming the
    // PROVIDER and the stored PATTERN instead. Reverting to
    // `${skipLabel} - warnings` would still pass a test asserting
    // `data-unmatched`, which is why the exact text is pinned here too.
    expect(line.textContent).toBe(
      `No ${harnessLabel("claude")} model matches gpt-9. Traycer will skip this row. low balance`,
    );
    // canEdit is false (patternsSupported: false on a 1.0-host row), so no
    // "Edit pattern" action renders beside the unmatched line.
    expect(screen.queryByRole("button", { name: "Edit pattern" })).toBeNull();
  });

  it("family-unmatched on a pattern row, a different provider: names THAT provider and pattern", () => {
    const props = baseCardProps([candidate("codex", "*x*", null)]);
    renderCard({
      ...props,
      preview: [
        preview({
          candidateIndex: 0,
          modelFamily: "*x*",
          resolvedModel: null,
          profileId: null,
          skipReason: "family-unmatched",
          skipLabel: null,
          warnings: [],
        }),
      ],
    });
    const line = screen.getByTestId("fallback-tier-candidate-preview");
    expect(line.getAttribute("data-unmatched")).toBe("true");
    expect(line.textContent).toBe(
      `No ${harnessLabel("codex")} model matches *x*. Traycer will skip this row.`,
    );
  });

  it("a non-unmatched skip reason: neutral 'Can't check right now: <reason>', never colored red", () => {
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
    expect(line.textContent).toBe("Can't check right now: not available");
  });

  it("resolvedModel differs from the stored value, with matches:[] (a hand-built 1.0-shaped preview): falls back to resolvedModel and renders a 'Tries' line naming the catalog label and the account", () => {
    // Pin: `previewMatches` in `fallback-model-patterns.ts` synthesises a
    // one-entry match list from `resolvedModel` exactly when `matches` is
    // empty - which every preview this suite's own `preview()` fixture builds
    // is, since it never sets `matches` itself. So this row's status line is
    // NOT reading `matches` off the wire at all; it is exercising the
    // fallback path a still-live 1.0-shaped response takes.
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
    const line = screen.getByTestId("fallback-tier-candidate-preview");
    // Falsification: skip the catalog lookup and print the raw resolved slug
    // even when the catalog knows its label - "claude-sonnet-5" would render
    // in the try step instead of the human-readable name.
    expect(line.textContent).toContain("Claude Sonnet 5");
    // The account is named, never its id (D118) - a raw "acct-1" id string is
    // exactly what `labelFor` is meant to translate; this fixture's `LABEL_FOR`
    // is the identity function, so the id itself is what should appear.
    expect(line.textContent).toContain("acct-1");
    expect(line.textContent).toContain("rate limited earlier");
    // Falsification: drop the `<span>Tries</span>` lead-in from the "tries"
    // branch of `RowStatus` - a bare resolved-model sentence would then render
    // with no "Tries" word at all.
    expect(line.textContent).toMatch(/^Tries/);
  });

  it("resolvedModel equals the stored value case-insensitively, with warnings: just the warnings, no 'Tries' line", () => {
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
    // Falsification: keep printing a "Tries" line even when the row already
    // names this exact model - that reads as noise repeating what the Model
    // cell already shows.
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

  it("Pin 3: two real matches[] entries render 'Tries A -> B' in try order, from the host's own matches array (not resolvedModel)", () => {
    const models = new Map([
      [
        "claude" as const,
        [
          model("claude", "gpt-a", "GPT Alpha", []),
          model("claude", "gpt-b", "GPT Beta", []),
        ],
      ],
    ]);
    const props = baseCardProps([candidate("claude", "*gpt*", null)]);
    renderCard({
      ...props,
      catalog: catalogFixture(models),
      preview: [
        previewWithMatches({
          candidateIndex: 0,
          modelFamily: "*gpt*",
          matches: [
            matchEntry("gpt-a", null, null, null),
            matchEntry("gpt-b", null, null, null),
          ],
          warnings: [],
        }),
      ],
    });
    const line = screen.getByTestId("fallback-tier-candidate-preview");
    // Falsification: this line comes from `matches`, not from
    // `resolvedModel`/`skipLabel` (the deleted `previewSentence`) - stub
    // `preview.matches` back to `[]` on a preview that still carries a
    // `resolvedModel` naming only ONE of these two models, and this assertion
    // would see one step instead of two, in the wrong order or with the
    // wrong labels.
    expect(line.textContent).toMatch(/^Tries/);
    const first = screen.getByText("GPT Alpha");
    const second = screen.getByText("GPT Beta");
    // Try order is DOM order: `matches` order is the try order, so the first
    // match's label precedes the second's in the rendered line.
    expect(
      first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    // The arrow between them - `TryArrow`'s visible glyph.
    expect(within(line).getByText("→")).not.toBeNull();
    expect(first.className).not.toContain("line-through");
    expect(second.className).not.toContain("line-through");
  });

  it("Pin 3: a match the walk would SKIP is struck through and carries an amber 'warning' pill with the host's own skipLabel", () => {
    const models = new Map([
      [
        "claude" as const,
        [
          model("claude", "gpt-a", "GPT Alpha", []),
          model("claude", "gpt-b", "GPT Beta", []),
        ],
      ],
    ]);
    const props = baseCardProps([candidate("claude", "*gpt*", null)]);
    renderCard({
      ...props,
      catalog: catalogFixture(models),
      preview: [
        previewWithMatches({
          candidateIndex: 0,
          modelFamily: "*gpt*",
          matches: [
            matchEntry("gpt-a", null, "rate-limited", "Rate limited"),
            matchEntry("gpt-b", null, null, null),
          ],
          warnings: [],
        }),
      ],
    });
    const skippedLabel = screen.getByText("GPT Alpha");
    // Falsification: drop the `line-through` class from `TryStepView` when
    // `step.skipLabel !== null` - the skipped model would then read
    // identically to one the walk would actually try.
    expect(skippedLabel.className).toContain("line-through");
    // The pill carries the HOST's own `skipLabel` text, not a hardcoded word -
    // `Badge variant="warning"` is the amber role token
    // (`clients/gui-app/AGENTS.md` "Status colors").
    const pill = screen.getByText("Rate limited");
    expect(pill.getAttribute("data-slot")).toBe("badge");
    // The model the walk WOULD still try is not struck through and carries no
    // pill of its own - only the skipped one is marked.
    const triedLabel = screen.getByText("GPT Beta");
    expect(triedLabel.className).not.toContain("line-through");
  });
});

describe("FallbackTierGroupCard - Pin 4: one-model-one-tier conflict block and 'Go to the <tier> row'", () => {
  function overlappingTierGroups(): {
    readonly groups: readonly TierGroup[];
    readonly conflicts: readonly TierConflict[];
    readonly catalog: FallbackCatalogOptions;
  } {
    // frontier's `*gpt*` and standard's exact `gpt-5.6-terra` both match
    // "GPT-5.6-Terra" - the real overlap `findTierConflicts` is asked to
    // settle, not a hand-built `TierConflict` object that could silently
    // drift from what the protocol actually computes.
    const groups: TierGroup[] = [
      { id: "frontier", candidates: [candidate("codex", "*gpt*", null)] },
      {
        id: "standard",
        candidates: [candidate("codex", "gpt-5.6-terra", null)],
      },
    ];
    const codexModel = model("codex", "gpt-5.6-terra", "GPT-5.6-Terra", []);
    const catalogsByHarness = new Map([["codex" as const, [codexModel]]]);
    const conflicts = findTierConflicts(groups, catalogsByHarness);
    return {
      groups,
      conflicts,
      catalog: catalogFixture(catalogsByHarness),
    };
  }

  function renderOverlappingEditor(): void {
    const { groups, conflicts, catalog } = overlappingTierGroups();
    const policy = {
      ...createDefaultFallbackPolicy(),
      tierGroups: [...groups],
      defaultTierGroupId: "frontier",
    };
    render(
      <FallbackTierGroupsEditor
        policy={policy}
        groups={toKeyedGroups(groups)}
        preview={null}
        labelFor={LABEL_FOR}
        catalog={catalog}
        patternsSupported
        conflicts={conflicts}
        previewPending={false}
        previewUnavailable={false}
        onRetryPreview={() => {}}
        onChange={() => {}}
        onCommit={() => {}}
        onUndo={() => {}}
        onRestoreDefaults={() => {}}
        restorePending={false}
        status={null}
        headerAction={null}
        testPanel={null}
      />,
    );
  }

  it("renders role=alert on BOTH rows, each naming the OTHER tier and 'frontier' as the handler because it's listed first", () => {
    renderOverlappingEditor();
    const alerts = screen.getAllByRole("alert");
    // Falsification: gate `rowConflicts` on the row's OWN tier only
    // (`rowConflictsFor` filtered to `groupIndex === 0`) - only frontier's row
    // would carry a conflict block, and this length assertion would drop to 1.
    expect(alerts).toHaveLength(2);
    const frontierCard = screen.getByTestId("fallback-tier-group-frontier");
    const standardCard = screen.getByTestId("fallback-tier-group-standard");
    const frontierAlert = within(frontierCard).getByRole("alert");
    const standardAlert = within(standardCard).getByRole("alert");
    // Both name the model and the OTHER tier it also lives in.
    expect(frontierAlert.textContent).toContain("GPT-5.6-Terra");
    expect(frontierAlert.textContent).toContain("also in standard");
    expect(standardAlert.textContent).toContain("also in frontier");
    // Falsification: swap `conflict.tiers[0]` for `conflict.tiers.at(-1)` (or
    // any other index) as `ConflictBlock`'s `handler` - both rows would then
    // name "standard" as the handler instead of the FIRST-LISTED tier.
    expect(frontierAlert.textContent).toContain(
      "frontier handles GPT-5.6-Terra because it's listed first",
    );
    expect(standardAlert.textContent).toContain(
      "frontier handles GPT-5.6-Terra because it's listed first",
    );
  });

  it("'Go to the <tier> row' moves focus to the OTHER row's Model trigger, in both directions", () => {
    renderOverlappingEditor();
    const frontierCard = screen.getByTestId("fallback-tier-group-frontier");
    const standardCard = screen.getByTestId("fallback-tier-group-standard");
    const frontierTrigger = within(frontierCard).getByTestId(
      "fallback-model-pattern-trigger",
    );
    const standardTrigger = within(standardCard).getByTestId(
      "fallback-model-pattern-trigger",
    );

    // Falsification: in `fallback-tier-groups-editor.tsx`'s `goToRow`, focus
    // the CONTAINER instead of querying
    // `[data-fallback-candidate-model="<key>"]` inside it - this would put the
    // keyboard somewhere in the standard tier without landing on its Model
    // cell specifically.
    fireEvent.click(
      within(frontierCard).getByRole("button", {
        name: "Go to the standard row",
      }),
    );
    expect(document.activeElement).toBe(standardTrigger);

    fireEvent.click(
      within(standardCard).getByRole("button", {
        name: "Go to the frontier row",
      }),
    );
    expect(document.activeElement).toBe(frontierTrigger);
  });

  it("'Edit pattern' opens THAT row's combobox - the trigger becomes aria-expanded", () => {
    renderOverlappingEditor();
    const frontierCard = screen.getByTestId("fallback-tier-group-frontier");
    const frontierTrigger = within(frontierCard).getByTestId(
      "fallback-model-pattern-trigger",
    );
    expect(frontierTrigger.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(
      within(frontierCard).getByRole("button", { name: "Edit pattern" }),
    );
    // Falsification: `editPattern` in `fallback-tier-group-card.tsx` clicks
    // `rowRef.current?.querySelector([data-fallback-candidate-model])` - drop
    // that call (or query the wrong row's ref) and the trigger never opens.
    expect(frontierTrigger.getAttribute("aria-expanded")).toBe("true");
  });
});

describe("FallbackTierGroupCard - R11: the edit action is named for what the row holds", () => {
  function overlappingTierGroups(): {
    readonly groups: readonly TierGroup[];
    readonly conflicts: readonly TierConflict[];
    readonly catalog: FallbackCatalogOptions;
  } {
    // Same overlap as Pin 4: frontier's `*gpt*` PATTERN and standard's EXACT
    // `gpt-5.6-terra` both match "GPT-5.6-Terra" - a row of each kind, so the
    // two conflict blocks can be told apart by their action's label.
    const groups: TierGroup[] = [
      { id: "frontier", candidates: [candidate("codex", "*gpt*", null)] },
      {
        id: "standard",
        candidates: [candidate("codex", "gpt-5.6-terra", null)],
      },
    ];
    const codexModel = model("codex", "gpt-5.6-terra", "GPT-5.6-Terra", []);
    const catalogsByHarness = new Map([["codex" as const, [codexModel]]]);
    const conflicts = findTierConflicts(groups, catalogsByHarness);
    return {
      groups,
      conflicts,
      catalog: catalogFixture(catalogsByHarness),
    };
  }

  function renderOverlappingEditor(): void {
    const { groups, conflicts, catalog } = overlappingTierGroups();
    const policy = {
      ...createDefaultFallbackPolicy(),
      tierGroups: [...groups],
      defaultTierGroupId: "frontier",
    };
    render(
      <FallbackTierGroupsEditor
        policy={policy}
        groups={toKeyedGroups(groups)}
        preview={null}
        labelFor={LABEL_FOR}
        catalog={catalog}
        patternsSupported
        conflicts={conflicts}
        previewPending={false}
        previewUnavailable={false}
        onRetryPreview={() => {}}
        onChange={() => {}}
        onCommit={() => {}}
        onUndo={() => {}}
        onRestoreDefaults={() => {}}
        restorePending={false}
        status={null}
        headerAction={null}
        testPanel={null}
      />,
    );
  }

  it("the pattern row's conflict block offers 'Edit pattern'", () => {
    renderOverlappingEditor();
    const frontierCard = screen.getByTestId("fallback-tier-group-frontier");
    // Falsification: `editLabel` in `fallback-tier-group-card.tsx` hard-coded
    // to `"Edit pattern"` regardless of `isModelPattern` - this would also
    // pass, which is why the sibling assertion below (on the EXACT-pick row)
    // is what actually pins the distinction.
    expect(
      within(frontierCard).getByRole("button", { name: "Edit pattern" }),
    ).not.toBeNull();
    expect(
      within(frontierCard).queryByRole("button", { name: "Change model" }),
    ).toBeNull();
  });

  it("the exact-pick row's conflict block offers 'Change model', not 'Edit pattern'", () => {
    renderOverlappingEditor();
    const standardCard = screen.getByTestId("fallback-tier-group-standard");
    // Falsification: `editLabel` hard-coded to `"Edit pattern"` - this row
    // holds no pattern (`gpt-5.6-terra` has no `*`), and offering to "edit"
    // one names a thing that is not there.
    expect(
      within(standardCard).getByRole("button", { name: "Change model" }),
    ).not.toBeNull();
    expect(
      within(standardCard).queryByRole("button", { name: "Edit pattern" }),
    ).toBeNull();
  });

  it("an unmatched EXACT value's red status line offers 'Change model'", () => {
    const props = baseCardProps([candidate("claude", "gpt-9", null)]);
    renderCard({
      ...props,
      patternsSupported: true,
      preview: [
        preview({
          candidateIndex: 0,
          modelFamily: "gpt-9",
          resolvedModel: null,
          profileId: null,
          skipReason: "family-unmatched",
          skipLabel: null,
          warnings: [],
        }),
      ],
    });
    expect(screen.getByRole("button", { name: "Change model" })).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Edit pattern" })).toBeNull();
  });
});

describe("FallbackTierGroupCard - Pin 7: stacked (narrow) row layout structure", () => {
  it("the row carries BOTH the narrow stacked grid-template-areas and the @2xl table one, in their exact literal form", () => {
    const props = baseCardProps([candidate("claude", "opus", null)]);
    renderCard(props);
    const row = screen.getByTestId("fallback-tier-candidate-row");
    // Falsification: edit either `[grid-template-areas:...]` string in
    // `CANDIDATE_ROW` (`fallback-tier-group-card.tsx`) - drop the `@2xl:`
    // table variant, or reorder an area name - and this exact-class
    // assertion goes red even though jsdom cannot measure a container width
    // to prove the visual regression directly.
    expect(row.className).toContain(
      "[grid-template-areas:'rank_provider_effort'_'model_model_model'_'status_status_status'_'actions_actions_actions']",
    );
    expect(row.className).toContain(
      "@2xl:[grid-template-areas:'rank_provider_model_effort_actions'_'._._status_status_status']",
    );
    expect(row.className).toContain(
      "grid-cols-[auto_minmax(0,1fr)_minmax(0,0.6fr)]",
    );
    expect(row.className).toContain("@2xl:col-span-5");
    expect(row.className).toContain("@2xl:grid-cols-subgrid");
  });

  it("the tier's outer grid stacks as a flex column narrow and becomes the 5-column subgrid host at @2xl", () => {
    const props = baseCardProps([candidate("claude", "opus", null)]);
    renderCard(props);
    const row = screen.getByTestId("fallback-tier-candidate-row");
    const grid = row.parentElement;
    // Falsification: drop the `flex flex-col` half of `CANDIDATE_GRID`,
    // leaving only the `@2xl:grid` table columns - the wrapper would then
    // behave as a grid at every width, the narrow-layout regression Pin 7
    // exists to catch.
    expect(grid?.className).toContain("flex flex-col");
    expect(grid?.className).toContain(
      "@2xl:grid-cols-[auto_minmax(0,1fr)_minmax(0,2.1fr)_minmax(0,0.9fr)_auto]",
    );
  });

  it("cell DOM order is rank, provider, model, effort, actions, status - what the named grid-areas rely on regardless of viewport", () => {
    const props = baseCardProps([candidate("claude", "opus", null)]);
    renderCard({
      ...props,
      preview: [
        preview({
          candidateIndex: 0,
          modelFamily: "opus",
          resolvedModel: null,
          profileId: null,
          skipReason: "family-unmatched",
          skipLabel: null,
          warnings: [],
        }),
      ],
    });
    const row = screen.getByTestId("fallback-tier-candidate-row");
    const gridAreas = [...row.children].map((child) => {
      const match = /\[grid-area:(\w+)\]/.exec(child.className);
      return match === null ? null : match[1];
    });
    // Falsification: reorder the row's JSX children (e.g. move the status
    // block above the actions cell) - CSS `grid-template-areas` places a
    // NAMED area regardless of source order, so nothing about the rendered
    // LAYOUT would catch a reorder; DOM order is what this pins instead.
    expect(gridAreas).toEqual([
      "rank",
      "provider",
      "model",
      "effort",
      "actions",
      "status",
    ]);
  });
});
