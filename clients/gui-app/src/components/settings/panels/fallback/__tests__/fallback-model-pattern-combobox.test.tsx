import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import type {
  TierCandidate,
  TierGroup,
} from "@traycer/protocol/host/fallback-policy";
import type {
  AgentReasoningEffortOption,
  GuiAgentModelOption,
} from "@traycer/protocol/host/index";
import {
  FallbackModelPatternCombobox,
  type FallbackModelPatternComboboxProps,
} from "@/components/settings/panels/fallback/fallback-model-pattern-combobox";

afterEach(() => {
  cleanup();
});

function effort(id: string, label: string): AgentReasoningEffortOption {
  return { id, label, description: null };
}

const ANY_EFFORTS = [effort("high", "High"), effort("medium", "Medium")];

function model(
  harnessId: GuiAgentModelOption["harnessId"],
  slug: string,
  label: string,
): GuiAgentModelOption {
  return {
    harnessId,
    slug,
    label,
    description: null,
    contextWindow: null,
    maxOutputTokens: null,
    defaultReasoningEffort: null,
    supportedReasoningEfforts: ANY_EFFORTS,
    defaultServiceTier: null,
    supportedServiceTiers: [],
    metadata: {},
  };
}

const GPT_ASTRA = model("codex", "gpt-6-astra", "GPT-6-Astra");
const GPT_SOL = model("codex", "gpt-6-sol", "GPT-6-Sol");
const GPT_LUNA = model("codex", "gpt-6-luna", "GPT-6-Luna");
const GPT_LUNA_MINI = model("codex", "gpt-6-luna-mini", "GPT-6-Luna Mini");
const GPT_TERRA = model("codex", "gpt-5.6-terra", "GPT-5.6-Terra");
const CODEX_CATALOG: readonly GuiAgentModelOption[] = [
  GPT_ASTRA,
  GPT_SOL,
  GPT_LUNA,
  GPT_LUNA_MINI,
  GPT_TERRA,
];

function candidate(
  harnessId: TierCandidate["harnessId"],
  modelFamily: string,
): TierCandidate {
  return { harnessId, modelFamily, reasoningEffort: null };
}

function group(id: string, candidates: readonly TierCandidate[]): TierGroup {
  return { id, candidates: [...candidates] };
}

interface ComboboxTestProps {
  readonly id: string;
  readonly rowKey: string;
  readonly modelFamily: string;
  readonly harnessId: TierCandidate["harnessId"];
  readonly providerLabel: string;
  readonly models: readonly GuiAgentModelOption[] | null;
  readonly groups: readonly TierGroup[];
  readonly groupIndex: number;
  readonly candidateIndex: number;
  readonly conflictCount: number;
  readonly describedBy: undefined;
  readonly onChange: Mock<(next: string) => void>;
  readonly onAnnounce: Mock<(text: string) => void>;
}

function baseProps(overrides: {
  readonly modelFamily: string;
  readonly groups: readonly TierGroup[];
  readonly groupIndex: number;
  readonly candidateIndex: number;
  readonly conflictCount: number;
}): ComboboxTestProps {
  return {
    id: "row-model",
    rowKey: "row-1",
    modelFamily: overrides.modelFamily,
    harnessId: "codex",
    providerLabel: "Codex",
    models: CODEX_CATALOG,
    groups: overrides.groups,
    groupIndex: overrides.groupIndex,
    candidateIndex: overrides.candidateIndex,
    conflictCount: overrides.conflictCount,
    describedBy: undefined,
    onChange: vi.fn(),
    onAnnounce: vi.fn(),
  };
}

function renderCombobox(props: ComboboxTestProps): void {
  const comboboxProps: FallbackModelPatternComboboxProps = props;
  render(<FallbackModelPatternCombobox {...comboboxProps} />);
}

function openPicker(): void {
  fireEvent.click(screen.getByTestId("fallback-model-pattern-trigger"));
}

function getInput(): HTMLInputElement {
  return screen.getByTestId("fallback-model-pattern-input") as HTMLInputElement;
}

function typeQuery(text: string): void {
  fireEvent.change(getInput(), { target: { value: text } });
}

function pressKey(key: string): void {
  fireEvent.keyDown(getInput(), { key });
}

/** The option whose data-value the input's aria-activedescendant currently names. */
function activeOptionText(): string | null {
  const activeId = getInput().getAttribute("aria-activedescendant");
  if (activeId === null) return null;
  const active = document.getElementById(activeId);
  return active === null ? null : active.textContent;
}

describe("FallbackModelPatternCombobox - Pin 1: Enter semantics", () => {
  it("typing an exact model slug puts that model first; Enter saves the SLUG", () => {
    const props = baseProps({
      modelFamily: "",
      groups: [group("flagship", [candidate("codex", "")])],
      groupIndex: 0,
      candidateIndex: 0,
      conflictCount: 0,
    });
    renderCombobox(props);
    openPicker();
    typeQuery("gpt-6-astra");
    const options = screen.getAllByTestId(/fallback-model-(pattern-)?option/);
    // Falsification: `buildPatternPicker`'s exact-match branch dropped - the
    // exact model would then not lead, and the first option would be the
    // pattern entry instead.
    expect(options[0].getAttribute("data-testid")).toBe(
      "fallback-model-option",
    );
    expect(within(options[0]).getByText("GPT-6-Astra")).not.toBeNull();
    pressKey("Enter");
    expect(props.onChange).toHaveBeenCalledWith("gpt-6-astra");
    expect(props.onAnnounce).not.toHaveBeenCalled();
  });

  it("typing an exact model LABEL also leads and Enter saves its slug", () => {
    const props = baseProps({
      modelFamily: "",
      groups: [group("flagship", [candidate("codex", "")])],
      groupIndex: 0,
      candidateIndex: 0,
      conflictCount: 0,
    });
    renderCombobox(props);
    openPicker();
    typeQuery("GPT-6-Sol");
    pressKey("Enter");
    expect(props.onChange).toHaveBeenCalledWith("gpt-6-sol");
  });

  it("typing 'luna' (3+ chars, no exact match) offers 'Any model containing \"luna\"' reaching 2 models; Enter saves *luna*", () => {
    const props = baseProps({
      modelFamily: "",
      groups: [group("flagship", [candidate("codex", "")])],
      groupIndex: 0,
      candidateIndex: 0,
      conflictCount: 0,
    });
    renderCombobox(props);
    openPicker();
    typeQuery("luna");
    const patternOption = screen.getByTestId("fallback-model-pattern-option");
    // Falsification: `CONTAINS_MIN_LENGTH` raised above 4, or the "contains"
    // wording branch in `PatternOption` dropped - this text would not render.
    expect(patternOption.textContent).toContain("Any model containing");
    expect(patternOption.textContent).toContain("luna");
    expect(patternOption.textContent).toContain("2 models");
    fireEvent.click(patternOption);
    expect(props.onChange).toHaveBeenCalledWith("*luna*");
  });

  it("typing a `*` pattern (e.g. *astra*) builds it directly, with no 'contains' wording", () => {
    const props = baseProps({
      modelFamily: "",
      groups: [group("flagship", [candidate("codex", "")])],
      groupIndex: 0,
      candidateIndex: 0,
      conflictCount: 0,
    });
    renderCombobox(props);
    openPicker();
    typeQuery("*astra*");
    const patternOption = screen.getByTestId("fallback-model-pattern-option");
    // Falsification: `pickerPatternFor` treating a typed `*` as a plain word
    // - "Any model containing" would then render instead of the literal
    // pattern.
    expect(patternOption.textContent).not.toContain("containing");
    expect(within(patternOption).getByText("*astra*")).not.toBeNull();
    fireEvent.click(patternOption);
    expect(props.onChange).toHaveBeenCalledWith("*astra*");
  });

  it("matches are numbered in catalog/try order", () => {
    const props = baseProps({
      modelFamily: "",
      groups: [group("flagship", [candidate("codex", "")])],
      groupIndex: 0,
      candidateIndex: 0,
      conflictCount: 0,
    });
    renderCombobox(props);
    openPicker();
    typeQuery("*gpt-6*");
    const astraOption = screen
      .getAllByTestId("fallback-model-option")
      .find((option) => option.textContent.includes("GPT-6-Astra"));
    const solOption = screen
      .getAllByTestId("fallback-model-option")
      .find((option) => option.textContent.includes("GPT-6-Sol"));
    expect(astraOption).toBeDefined();
    expect(solOption).toBeDefined();
    if (astraOption === undefined || solOption === undefined) return;
    // Falsification: `ModelOption`'s rank badge not rendering `entry.rank`,
    // or `buildPatternPicker` numbering off the wrong list - the visible
    // rank glyphs would then not read "1" and "2" in catalog order.
    expect(astraOption.textContent).toContain("1");
    expect(solOption.textContent).toContain("2");
  });

  it("ArrowDown/ArrowUp move aria-activedescendant across visible options", () => {
    const props = baseProps({
      modelFamily: "",
      groups: [group("flagship", [candidate("codex", "")])],
      groupIndex: 0,
      candidateIndex: 0,
      conflictCount: 0,
    });
    renderCombobox(props);
    openPicker();
    typeQuery("*gpt-6*");
    const before = activeOptionText();
    pressKey("ArrowDown");
    const afterDown = activeOptionText();
    // Falsification: `move()`'s `at`/`from`/`next` clamping math broken, or
    // the layout effect that writes `aria-activedescendant` removed - the
    // active option would then never change on ArrowDown.
    expect(afterDown).not.toBe(before);
    pressKey("ArrowUp");
    const afterUp = activeOptionText();
    expect(afterUp).toBe(before);
  });
});

describe("FallbackModelPatternCombobox - Pin 2: disabled conflicting option + announcement", () => {
  // standard tier's row 0 is being edited; frontier already claims
  // gpt-6-astra and flagship already claims gpt-6-sol.
  function conflictGroups(): readonly TierGroup[] {
    return [
      group("frontier", [candidate("codex", "*astra*")]),
      group("flagship", [candidate("codex", "*sol*")]),
      group("standard", [candidate("codex", "")]),
    ];
  }

  it("typing gpt-6-* makes the pattern option aria-disabled with the two-owner reason; Enter announces instead of changing", () => {
    const props = baseProps({
      modelFamily: "",
      groups: conflictGroups(),
      groupIndex: 2,
      candidateIndex: 0,
      conflictCount: 0,
    });
    renderCombobox(props);
    openPicker();
    typeQuery("gpt-6-*");
    const patternOption = screen.getByTestId("fallback-model-pattern-option");
    // Falsification: `PatternOption`'s `disabled={blocked}` prop dropped, or
    // `pickerEntryBlocked` not checked before rendering `aria-disabled` -
    // the option would then be enabled even though astra and sol are
    // already claimed by other tiers.
    expect(patternOption.getAttribute("aria-disabled")).toBe("true");
    expect(patternOption.textContent).toContain(
      "GPT-6-Astra is in frontier and GPT-6-Sol is in flagship",
    );
    // No exact catalog match for "gpt-6-*" (it contains `*`, so it is never
    // treated as a plain word either), so the pattern entry is the FIRST
    // visible option and is already highlighted with no arrow key needed.
    const activeId = getInput().getAttribute("aria-activedescendant");
    expect(activeId).not.toBeNull();
    expect(document.getElementById(activeId ?? "")).toBe(patternOption);
    pressKey("Enter");
    // Falsification: `choose()` calling `onPick` unconditionally instead of
    // checking `entry.blockers.length > 0` first - `onChange` would then be
    // called with "*gpt-6-*" despite the conflict.
    expect(props.onChange).not.toHaveBeenCalled();
    expect(props.onAnnounce).toHaveBeenCalledWith(
      "Can't use: GPT-6-Astra is in frontier and GPT-6-Sol is in flagship. A model can be in only one tier.",
    );
  });

  it("a model owned by another tier shows an 'in <tier>' badge; Enter announces modelOwnedReason instead of changing", () => {
    const props = baseProps({
      modelFamily: "",
      groups: conflictGroups(),
      groupIndex: 2,
      candidateIndex: 0,
      conflictCount: 0,
    });
    renderCombobox(props);
    openPicker();
    typeQuery("gpt-6-astra");
    // Typing the exact slug also offers a `*gpt-6-astra*` pattern (any word
    // of 3+ chars does), so every catalog model still renders - the exact
    // match leads the list as the first option.
    const astraOption = screen.getAllByTestId("fallback-model-option")[0];
    // Falsification: `ModelOption`'s owned Badge rendering dropped, or its
    // text built without `tierDisplayName` - the "in frontier" badge would
    // then be absent even though frontier's `*astra*` row already claims
    // this model.
    expect(astraOption.textContent).toContain("GPT-6-Astra");
    expect(astraOption.textContent).toContain("in frontier");
    expect(astraOption.getAttribute("aria-disabled")).toBe("true");
    pressKey("Enter");
    // Falsification: `choose()`'s `entry.owners.length > 0` guard removed -
    // `onChange("gpt-6-astra")` would then fire despite the model already
    // belonging to frontier.
    expect(props.onChange).not.toHaveBeenCalled();
    expect(props.onAnnounce).toHaveBeenCalledWith(
      "GPT-6-Astra is in frontier. A model can be in only one tier.",
    );
  });
});

describe("FallbackModelPatternCombobox - Pin 13: combobox-relevant integration", () => {
  it("a model outside an offered pattern's reach still renders (unmatched) and stays choosable when no other tier owns it", () => {
    const props = baseProps({
      modelFamily: "",
      groups: [group("flagship", [candidate("codex", "")])],
      groupIndex: 0,
      candidateIndex: 0,
      conflictCount: 0,
    });
    renderCombobox(props);
    openPicker();
    typeQuery("*sol*");
    const astraOption = screen
      .getAllByTestId("fallback-model-option")
      .find((option) => option.textContent.includes("GPT-6-Astra"));
    expect(astraOption).toBeDefined();
    if (astraOption === undefined) return;
    // Falsification: `PatternPickerBody`'s render loop unmounting an
    // unmatched model instead of keeping it (with `hidden` merely toggled) -
    // astra would then not be found in the DOM at all while "*sol*" is
    // offered.
    expect(astraOption.hidden).toBe(false);
    expect(astraOption.getAttribute("aria-disabled")).not.toBe("true");
    fireEvent.click(astraOption);
    expect(props.onChange).toHaveBeenCalledWith("gpt-6-astra");
  });

  it("the trigger's accessible name includes the pattern and the match count pill", () => {
    const props = baseProps({
      modelFamily: "*opus*",
      groups: [group("flagship", [candidate("codex", "*opus*")])],
      groupIndex: 0,
      candidateIndex: 0,
      conflictCount: 0,
    });
    renderCombobox(props);
    const trigger = screen.getByTestId("fallback-model-pattern-trigger");
    // Falsification: `triggerFace`'s `spoken`/`accessibleName` composition
    // dropping the ", pattern" clause or the match-count pill - the
    // accessible name would then omit one of the two facts a screen-reader
    // user needs (spec §Accessibility).
    expect(trigger.getAttribute("aria-label")).toBe(
      "Model or pattern: *opus*, pattern, 0 models",
    );
  });
});
