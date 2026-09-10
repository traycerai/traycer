import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TierCandidatePreview } from "@traycer/protocol/host/fallback-policy";
import { FallbackTierGroupCard } from "@/components/settings/panels/fallback/fallback-tier-group-card";
import {
  keyedGroup,
  type KeyedGroup,
} from "@/components/settings/panels/fallback/fallback-tier-group-keys";
import type { FallbackEffortOptions } from "@/components/settings/panels/fallback/fallback-effort-options";

// R6: the family field is `FallbackModelFamilyInput`, which queries the
// harness catalog via `useHostClient()` - unreachable outside a
// `<HostRuntimeProvider>`. `data: undefined` is "no cached catalog", under
// which the component renders a plain textbox with no datalist.
vi.mock("@/hooks/harnesses/use-gui-harness-catalog", () => ({
  useGuiHarnessModelsQuery: () => ({ data: undefined }),
}));

// `globals: false` in vitest.config.ts means RTL's automatic cleanup never
// registers - every suite that renders must call this itself.
afterEach(() => {
  cleanup();
});

const LABEL_FOR = (profileId: string): string => profileId;
const NO_EFFORT_OPTIONS: FallbackEffortOptions = () => [];

function candidate(modelFamily: string): {
  readonly harnessId: "claude";
  readonly modelFamily: string;
  readonly reasoningEffort: null;
} {
  return { harnessId: "claude", modelFamily, reasoningEffort: null };
}

function renderCard(
  group: KeyedGroup,
  preview: readonly TierCandidatePreview[] | null,
): void {
  render(
    <FallbackTierGroupCard
      group={group}
      preview={preview}
      labelFor={LABEL_FOR}
      effortOptions={NO_EFFORT_OPTIONS}
      onChange={vi.fn()}
      onCommit={vi.fn()}
      onDelete={vi.fn()}
      onUndo={vi.fn()}
      defaultHarnessId="claude"
    />,
  );
}

function preview(
  overrides: Partial<TierCandidatePreview>,
): TierCandidatePreview {
  return {
    groupId: "fast",
    candidateIndex: 0,
    harnessId: "claude",
    modelFamily: "opus",
    reasoningEffort: null,
    resolvedModel: "claude-opus-4",
    profileId: null,
    skipReason: null,
    skipLabel: null,
    warnings: [],
    ...overrides,
  };
}

describe("FallbackTierGroupCard - AX8: the group container is named", () => {
  it("a named group renders role=group with 'Model group <id>'", () => {
    renderCard(
      keyedGroup({ id: "fast", candidates: [candidate("opus")] }),
      null,
    );
    // Falsification: drop `aria-label={groupContainerLabel(group.id)}` from
    // the card's outer `<div role="group">` - this query would then find
    // nothing.
    expect(
      screen.getByRole("group", { name: "Model group fast" }),
    ).not.toBeNull();
  });

  it("a blank-name group renders role=group with 'Unnamed model group', not a position", () => {
    renderCard(keyedGroup({ id: "", candidates: [] }), null);
    // Falsification: have `groupContainerLabel` fall back to a position
    // ("Group 1") instead - that string belongs to the VALIDATION message
    // (`groupPosition` in `fallback-policy-draft.ts`), and using it here too
    // would make the container and the error line say two different things
    // about the same row when a test reads them.
    expect(
      screen.getByRole("group", { name: "Unnamed model group" }),
    ).not.toBeNull();
  });
});

describe("FallbackTierGroupCard - AX8: candidate rows disambiguate by position, nested inside their group", () => {
  it("two groups on screen, one with two rows: each Model family field resolves to exactly one element within its own named row", () => {
    const fast = keyedGroup({
      id: "fast",
      candidates: [candidate("opus"), candidate("sonnet")],
    });
    const slow = keyedGroup({ id: "slow", candidates: [candidate("haiku")] });
    render(
      <>
        <FallbackTierGroupCard
          group={fast}
          preview={null}
          labelFor={LABEL_FOR}
          effortOptions={NO_EFFORT_OPTIONS}
          onChange={vi.fn()}
          onCommit={vi.fn()}
          onDelete={vi.fn()}
          onUndo={vi.fn()}
          defaultHarnessId="claude"
        />
        <FallbackTierGroupCard
          group={slow}
          preview={null}
          labelFor={LABEL_FOR}
          effortOptions={NO_EFFORT_OPTIONS}
          onChange={vi.fn()}
          onCommit={vi.fn()}
          onDelete={vi.fn()}
          onUndo={vi.fn()}
          defaultHarnessId="claude"
        />
      </>,
    );

    // The GROUP is disambiguated by its own accessible name...
    const fastGroup = screen.getByRole("group", { name: "Model group fast" });
    // ...and the ROW within it, by position - "Model family" alone is not
    // unique across four rows total (two in "fast"), so the row container is
    // what makes `within(row)` resolve to exactly one field.
    //
    // Falsification: drop `aria-label={`Model ${index + 1}`}` from
    // `CandidateRow`'s own container - `within(fastGroup).getByRole("group",
    // {name: "Model 2"})` would then throw, since nothing distinguishes the
    // two rows from each other.
    const secondRow = within(fastGroup).getByRole("group", {
      name: "Model 2",
    });
    expect(
      within(secondRow).getByRole("textbox", { name: "Model family" }),
    ).not.toBeNull();

    const firstRow = within(fastGroup).getByRole("group", { name: "Model 1" });
    expect(
      within(firstRow).getByRole("textbox", { name: "Model family" }),
    ).not.toBeNull();
  });
});

describe("FallbackTierGroupCard - AX8: the Model family field's description and validity", () => {
  it("has an accessible description resolving to the preview verdict line when a preview is present", () => {
    renderCard(keyedGroup({ id: "fast", candidates: [candidate("opus")] }), [
      preview({ resolvedModel: "claude-opus-4" }),
    ]);
    const family = screen.getByRole("textbox", { name: "Model family" });
    const describedBy = family.getAttribute("aria-describedby");
    // Falsification: drop `aria-describedby={preview === null ? undefined :
    // previewId}` from the family input - `describedBy` would then be `null`
    // even though a preview line is rendered right beside it.
    expect(describedBy).not.toBeNull();
    const description =
      describedBy === null ? null : document.getElementById(describedBy);
    expect(description?.textContent ?? "").toContain("resolves to");
    expect(description?.textContent ?? "").toContain("claude-opus-4");
  });

  it("has NO accessible description when preview is null - D159 absence, not a dangling id", () => {
    renderCard(
      keyedGroup({ id: "fast", candidates: [candidate("opus")] }),
      null,
    );
    const family = screen.getByRole("textbox", { name: "Model family" });
    // Falsification: always point `aria-describedby` at `previewId` even
    // when nothing is rendered there - a dangling reference to an element
    // that does not exist, which is worse than no description at all.
    expect(family.getAttribute("aria-describedby")).toBeNull();
    expect(screen.queryByTestId("fallback-tier-candidate-preview")).toBeNull();
  });

  it("a blank family value carries aria-invalid; a filled one does not", () => {
    renderCard(
      keyedGroup({
        id: "fast",
        candidates: [candidate(""), candidate("opus")],
      }),
      null,
    );
    const [blank, filled] = screen.getAllByRole("textbox", {
      name: "Model family",
    });
    // Falsification: drop the `aria-invalid={... ? true : undefined}` ternary
    // from the family input, or invert its condition.
    expect(blank.getAttribute("aria-invalid")).toBe("true");
    expect(filled.getAttribute("aria-invalid")).toBeNull();
  });
});
