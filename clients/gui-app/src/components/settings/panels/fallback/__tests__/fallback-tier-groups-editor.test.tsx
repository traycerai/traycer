import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
  type RenderResult,
} from "@testing-library/react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import {
  createDefaultFallbackPolicy,
  type FallbackPolicy,
  type TierCandidate,
  type TierCandidatePreview,
  type TierGroup,
} from "@traycer/protocol/host/fallback-policy";
import type {
  AgentReasoningEffortOption,
  GuiAgentModelOption,
} from "@traycer/protocol/host/index";
import type { HarnessId } from "@traycer/protocol/host/agent/shared";
import {
  applyGroupsInverse,
  toKeyedGroups,
  withTierGroups,
  type FallbackGroupsInverse,
  type KeyedGroup,
} from "@/components/settings/panels/fallback/fallback-tier-group-keys";
import {
  catalogModelForFamily,
  type FallbackCatalogOptions,
} from "@/components/settings/panels/fallback/fallback-catalog-options";
import { fallbackTierConflicts } from "@/components/settings/panels/fallback/fallback-policy-draft";
import {
  FallbackTierGroupsEditor,
  type FallbackTierGroupsEditorProps,
} from "@/components/settings/panels/fallback/fallback-tier-groups-editor";

/** The shape of the second argument the removal toasts pass `toast.success`. */
interface UndoToastOptions {
  readonly action: { readonly label: string; readonly onClick: () => void };
}

const { toastSuccess } = vi.hoisted(() => ({
  toastSuccess: vi.fn<(message: string, options: UndoToastOptions) => void>(),
}));

vi.mock("sonner", () => ({
  toast: {
    success: toastSuccess,
    error: vi.fn(),
    info: vi.fn(),
    message: vi.fn(),
  },
}));

afterEach(() => {
  cleanup();
  toastSuccess.mockClear();
});

/**
 * Spies typed AT the mock, so a test can read `mock.calls[0]` as the policy
 * and groups the editor emitted without asserting a shape onto it. An untyped
 * `vi.fn()` types its calls as `any`, and the destructure then reads as an
 * unsafe member access - a lint refusal, not a cast, but the same smell: the
 * test would keep compiling after the editor stopped passing a policy at all.
 */
function commitSpy(): Mock<
  (next: FallbackPolicy, groups: readonly KeyedGroup[]) => void
> {
  return vi.fn<(next: FallbackPolicy, groups: readonly KeyedGroup[]) => void>();
}
function undoSpy(): Mock<(inverse: FallbackGroupsInverse) => void> {
  return vi.fn<(inverse: FallbackGroupsInverse) => void>();
}

function candidate(modelFamily: string): TierCandidate {
  return { harnessId: "claude", modelFamily, reasoningEffort: null };
}

function tierGroup(
  id: string,
  candidates: readonly TierCandidate[],
): TierGroup {
  return { id, candidates: [...candidates] };
}

const NO_CATALOG: FallbackCatalogOptions = {
  modelsFor: () => [],
  catalogFor: () => null,
  catalogsByHarness: new Map(),
  effortsFor: () => [],
};

/**
 * A minimal stateful wrapper - the editor is fully controlled
 * (`onChange(policy, groups)`), so a DOM test needs something to feed the
 * new `groups` back in. It passes back exactly what the editor handed it,
 * never a re-derivation from the returned policy: re-deriving would run every
 * row back through `toKeyedGroups` and mint fresh identities, which would
 * make this test pass or fail for the wrong reason regardless of what the
 * editor itself does with identity.
 *
 * `onUndo` mirrors the panel's own handling (`fallback-settings-panel.tsx`'s
 * `undoGroupsChange`): it reads the LATEST groups AND the latest policy off
 * refs, never off values closed over at the render that raised the toast, and
 * projects through the same `withTierGroups` the editor's own `toPolicy` uses -
 * one wire projection, not a second hand-rolled one. This file's own F18b test
 * below is what a stale-`policy` closure would NOT catch (only `tierGroups`
 * differs there), which is why the ref exists even though this suite never
 * edits a field outside `tierGroups` - the cross-field case is pinned at the
 * panel level, against the real `undoGroupsChange`.
 */
function Harness(props: {
  readonly initialPolicy: FallbackPolicy;
  readonly initialGroups: readonly KeyedGroup[];
  readonly previewUnavailable: boolean | undefined;
  readonly previewPending: boolean | undefined;
  readonly onRetryPreview: (() => void) | undefined;
}): ReactNode {
  const [policy, setPolicy] = useState(props.initialPolicy);
  const [groups, setGroups] = useState(props.initialGroups);
  const previewUnavailable = props.previewUnavailable ?? false;
  const previewPending = props.previewPending ?? false;
  const onRetryPreview = props.onRetryPreview ?? (() => {});
  const groupsRef = useRef(groups);
  const policyRef = useRef(policy);
  useEffect(() => {
    groupsRef.current = groups;
  }, [groups]);
  useEffect(() => {
    policyRef.current = policy;
  }, [policy]);
  const adopt = (
    nextPolicy: FallbackPolicy,
    nextGroups: readonly KeyedGroup[],
  ): void => {
    setPolicy(nextPolicy);
    setGroups(nextGroups);
  };
  return (
    <FallbackTierGroupsEditor
      policy={policy}
      groups={groups}
      preview={null}
      // No preview rows in this suite, so the resolver is never consulted - but
      // the prop is required, and an identity function keeps it honest about
      // that rather than pretending a label was produced.
      labelFor={(profileId) => profileId}
      catalog={NO_CATALOG}
      patternsSupported={false}
      conflicts={[]}
      previewPending={previewPending}
      previewUnavailable={previewUnavailable}
      onRetryPreview={onRetryPreview}
      onChange={adopt}
      onCommit={adopt}
      onUndo={(inverse: FallbackGroupsInverse) => {
        const current = groupsRef.current;
        const next = applyGroupsInverse(current, inverse);
        if (next === current) return;
        adopt(withTierGroups(policyRef.current, next), next);
      }}
      onRestoreDefaults={() => {}}
      restorePending={false}
      status={null}
      headerAction={null}
      testPanel={null}
    />
  );
}

/**
 * A narrower stateful wrapper for the default-marker COMMIT-path pin below.
 *
 * `onChange` feeds the draft back into state - same as `Harness` - so a
 * rename's keystroke is genuinely reflected in the `group` prop the CARD
 * closes over by the time a blur fires its commit (`commitOnLeave` commits
 * `group` AS IT STANDS AT RENDER TIME, not the raw DOM value - see the card's
 * own comment). `onCommit` is a pure spy instead of also updating state: this
 * harness exists to inspect exactly one commit's own arguments, not to
 * simulate the rest of a session.
 */
function CommitCarryHarness(props: {
  readonly initialPolicy: FallbackPolicy;
  readonly initialGroups: readonly KeyedGroup[];
  readonly onCommit: (
    policy: FallbackPolicy,
    groups: readonly KeyedGroup[],
  ) => void;
}): ReactNode {
  const [policy, setPolicy] = useState(props.initialPolicy);
  const [groups, setGroups] = useState(props.initialGroups);
  return (
    <FallbackTierGroupsEditor
      policy={policy}
      groups={groups}
      preview={null}
      labelFor={(profileId) => profileId}
      catalog={NO_CATALOG}
      patternsSupported={false}
      conflicts={[]}
      previewPending={false}
      previewUnavailable={false}
      onRetryPreview={() => {}}
      onChange={(nextPolicy, nextGroups) => {
        setPolicy(nextPolicy);
        setGroups(nextGroups);
      }}
      onCommit={props.onCommit}
      onUndo={() => {}}
      onRestoreDefaults={() => {}}
      restorePending={false}
      status={null}
      headerAction={null}
      testPanel={null}
    />
  );
}

describe("FallbackTierGroupsEditor - candidate identity survives a reorder", () => {
  it("moves the DOM node with the row, rather than keeping the node in place and swapping its value", () => {
    // Mutable, because this same array is assigned to `FallbackPolicy.tierGroups`
    // below and the zod output type is a mutable array. `toKeyedGroups` takes the
    // readonly form and accepts this one; the assignment does not go the other
    // way.
    const groups: TierGroup[] = [
      tierGroup("fast", [candidate("opus"), candidate("sonnet")]),
    ];
    render(
      <Harness
        initialPolicy={{ ...createDefaultFallbackPolicy(), tierGroups: groups }}
        initialGroups={toKeyedGroups(groups)}
        previewUnavailable={undefined}
        previewPending={undefined}
        onRetryPreview={undefined}
      />,
    );

    // The Model cell is a catalog `Select` now, not a free-text family input
    // - with no catalog (`NO_CATALOG.modelsFor` returns `[]`), the stored
    // family renders PINNED, as its own trigger text, so this still reads
    // the row's family off the DOM without depending on any catalog data.
    const modelControls = (): HTMLElement[] =>
      screen.getAllByRole("combobox", { name: "Model" });
    expect(modelControls().map((control) => control.textContent)).toEqual([
      "opus",
      "sonnet",
    ]);
    const secondRowControl = modelControls()[1];

    // Move the second row ("sonnet") up one place.
    fireEvent.click(screen.getAllByLabelText("Move up")[1]);

    const reordered = modelControls();
    expect(reordered.map((control) => control.textContent)).toEqual([
      "sonnet",
      "opus",
    ]);

    // The identity model's whole point: under `key={candidate.key}` React
    // MOVES the existing node to its new position, so the object captured
    // above IS the first control now - not merely a control with the same
    // text. Under an index key React would instead keep the node parked at
    // position 1 and swap only its content, and this assertion would see
    // the text change with the ELEMENT staying the same object at the OLD
    // index - i.e. `reordered[1]` would be `secondRowControl`, not
    // `reordered[0]`.
    expect(reordered[0]).toBe(secondRowControl);
  });
});

describe("FallbackTierGroupsEditor - F16 a group rename survives duplicate and empty intermediate names", () => {
  it("keeps the SAME DOM node through duplicate and empty intermediate values, commits the full final name on blur", () => {
    const groups: TierGroup[] = [tierGroup("fast", []), tierGroup("cheap", [])];
    render(
      <Harness
        initialPolicy={{ ...createDefaultFallbackPolicy(), tierGroups: groups }}
        initialGroups={toKeyedGroups(groups)}
        previewUnavailable={undefined}
        previewPending={undefined}
        onRetryPreview={undefined}
      />,
    );
    const nameInputs = () =>
      screen.getAllByLabelText<HTMLInputElement>("Tier name");
    const input = nameInputs()[0];
    input.focus();
    expect(document.activeElement).toBe(input);

    // Duplicate of the OTHER group's id, then empty, then the final name -
    // none of these commit (blur/Enter only), so the draft just keeps moving.
    for (const value of ["c", "ch", "cheap", "", "fastest"]) {
      fireEvent.change(input, { target: { value } });
      // Falsification: key the card on `group.id` instead of `group.draftKey`
      // (`fallback-tier-groups-editor.tsx`'s `key={group.draftKey}`) - a
      // rename through "cheap" (this group's sibling's id) would then remount
      // the card, and `nameInputs()[0]` would no longer be the SAME node as
      // `input`.
      expect(nameInputs()[0]).toBe(input);
      expect(document.activeElement).toBe(input);
    }

    fireEvent.blur(input);
    // The full final value is what the field holds - NOT evidence that blur
    // committed it. This harness routes `onChange` and `onCommit` to the same
    // `adopt`, so "fastest" was already in the input before the blur and this
    // assertion holds whether or not the blur commit exists. It is kept as the
    // closing state of the identity walk above, which is what this test pins.
    //
    // The commit rule itself is pinned where the real save path is observable:
    // "R6: a GROUP RENAME sends nothing while typing..." in
    // `panels/__tests__/fallback-settings-panel.test.tsx`, against the panel's
    // mutation spy.
    expect(nameInputs()[0].value).toBe("fastest");
  });

  it("negative half: the card's own data-testid (name-derived) DOES change across the rename, proving the node-identity pin above is not vacuous", () => {
    const groups: TierGroup[] = [tierGroup("fast", [])];
    render(
      <Harness
        initialPolicy={{ ...createDefaultFallbackPolicy(), tierGroups: groups }}
        initialGroups={toKeyedGroups(groups)}
        previewUnavailable={undefined}
        previewPending={undefined}
        onRetryPreview={undefined}
      />,
    );
    expect(
      document.querySelector('[data-testid="fallback-tier-group-fast"]'),
    ).not.toBeNull();
    const input = screen.getByLabelText<HTMLInputElement>("Tier name");
    fireEvent.change(input, { target: { value: "fastest" } });
    fireEvent.blur(input);
    expect(
      document.querySelector('[data-testid="fallback-tier-group-fastest"]'),
    ).not.toBeNull();
    expect(
      document.querySelector('[data-testid="fallback-tier-group-fast"]'),
    ).toBeNull();
  });
});

describe("FallbackTierGroupsEditor - F24 removal focus, group deletion", () => {
  function threeGroups(): TierGroup[] {
    return [tierGroup("g1", []), tierGroup("g2", []), tierGroup("g3", [])];
  }

  it("deleting the FIRST group focuses the group that takes its place", () => {
    const groups = threeGroups();
    render(
      <Harness
        initialPolicy={{ ...createDefaultFallbackPolicy(), tierGroups: groups }}
        initialGroups={toKeyedGroups(groups)}
        previewUnavailable={undefined}
        previewPending={undefined}
        onRetryPreview={undefined}
      />,
    );
    const deleteButtons = screen.getAllByRole("button", {
      name: "Delete tier",
    });
    const survivor = deleteButtons[1];
    fireEvent.click(deleteButtons[0]);
    // Falsification: pass `[]` instead of `groupDeleteSelectors(groups, index)`
    // into `focusAfterRemoval` at the `onDelete` call site
    // (`fallback-tier-groups-editor.tsx`) - focus would then fall through to
    // "Add tier" (or `document.body`) instead of the surviving neighbour.
    expect(document.activeElement).toBe(survivor);
  });

  it("deleting the MIDDLE group focuses the NEXT group, not the previous one", () => {
    const groups = threeGroups();
    render(
      <Harness
        initialPolicy={{ ...createDefaultFallbackPolicy(), tierGroups: groups }}
        initialGroups={toKeyedGroups(groups)}
        previewUnavailable={undefined}
        previewPending={undefined}
        onRetryPreview={undefined}
      />,
    );
    const deleteButtons = screen.getAllByRole("button", {
      name: "Delete tier",
    });
    const nextSurvivor = deleteButtons[2];
    fireEvent.click(deleteButtons[1]);
    expect(document.activeElement).toBe(nextSurvivor);
  });

  it("deleting the LAST group focuses its neighbour (there is no next one)", () => {
    const groups = threeGroups();
    render(
      <Harness
        initialPolicy={{ ...createDefaultFallbackPolicy(), tierGroups: groups }}
        initialGroups={toKeyedGroups(groups)}
        previewUnavailable={undefined}
        previewPending={undefined}
        onRetryPreview={undefined}
      />,
    );
    const deleteButtons = screen.getAllByRole("button", {
      name: "Delete tier",
    });
    const previousSurvivor = deleteButtons[1];
    fireEvent.click(deleteButtons[2]);
    expect(document.activeElement).toBe(previousSurvivor);
  });

  it("deleting the only remaining group focuses 'Add tier'", () => {
    const groups = [tierGroup("only", [])];
    render(
      <Harness
        initialPolicy={{ ...createDefaultFallbackPolicy(), tierGroups: groups }}
        initialGroups={toKeyedGroups(groups)}
        previewUnavailable={undefined}
        previewPending={undefined}
        onRetryPreview={undefined}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Delete tier" }));
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Add tier" }),
    );
  });
});

describe("FallbackTierGroupsEditor - F24 removal focus, candidate removal", () => {
  function oneGroupThreeCandidates(): TierGroup[] {
    return [
      tierGroup("g1", [
        candidate("alpha"),
        candidate("beta"),
        candidate("gamma"),
      ]),
    ];
  }

  it("removing the FIRST candidate focuses the row that takes its place", () => {
    const groups = oneGroupThreeCandidates();
    render(
      <Harness
        initialPolicy={{ ...createDefaultFallbackPolicy(), tierGroups: groups }}
        initialGroups={toKeyedGroups(groups)}
        previewUnavailable={undefined}
        previewPending={undefined}
        onRetryPreview={undefined}
      />,
    );
    const survivor = screen.getByRole("button", { name: "Remove beta" });
    fireEvent.click(screen.getByRole("button", { name: "Remove alpha" }));
    expect(document.activeElement).toBe(survivor);
  });

  it("removing the MIDDLE candidate focuses the NEXT one", () => {
    const groups = oneGroupThreeCandidates();
    render(
      <Harness
        initialPolicy={{ ...createDefaultFallbackPolicy(), tierGroups: groups }}
        initialGroups={toKeyedGroups(groups)}
        previewUnavailable={undefined}
        previewPending={undefined}
        onRetryPreview={undefined}
      />,
    );
    const survivor = screen.getByRole("button", { name: "Remove gamma" });
    fireEvent.click(screen.getByRole("button", { name: "Remove beta" }));
    expect(document.activeElement).toBe(survivor);
  });

  it("removing the LAST candidate focuses its neighbour", () => {
    const groups = oneGroupThreeCandidates();
    render(
      <Harness
        initialPolicy={{ ...createDefaultFallbackPolicy(), tierGroups: groups }}
        initialGroups={toKeyedGroups(groups)}
        previewUnavailable={undefined}
        previewPending={undefined}
        onRetryPreview={undefined}
      />,
    );
    const survivor = screen.getByRole("button", { name: "Remove beta" });
    fireEvent.click(screen.getByRole("button", { name: "Remove gamma" }));
    expect(document.activeElement).toBe(survivor);
  });

  it("removing the only remaining candidate focuses 'Add model'", () => {
    const groups = [tierGroup("g1", [candidate("alpha")])];
    render(
      <Harness
        initialPolicy={{ ...createDefaultFallbackPolicy(), tierGroups: groups }}
        initialGroups={toKeyedGroups(groups)}
        previewUnavailable={undefined}
        previewPending={undefined}
        onRetryPreview={undefined}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Remove alpha" }));
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Add model" }),
    );
  });
});

describe("FallbackTierGroupsEditor - F18 undo restores exactly the deleted row, not a snapshot", () => {
  it("deleting two groups, then pressing the FIRST toast's Undo, restores only that group", () => {
    const groups = [
      tierGroup("g1", []),
      tierGroup("g2", []),
      tierGroup("g3", []),
    ];
    render(
      <Harness
        initialPolicy={{ ...createDefaultFallbackPolicy(), tierGroups: groups }}
        initialGroups={toKeyedGroups(groups)}
        previewUnavailable={undefined}
        previewPending={undefined}
        onRetryPreview={undefined}
      />,
    );
    // Delete "g1" (index 0) first - its toast is `toast.success` call #1.
    fireEvent.click(screen.getAllByRole("button", { name: "Delete tier" })[0]);
    // Delete "g3" (now the last remaining, originally index 2) second.
    fireEvent.click(
      screen.getAllByRole("button", { name: "Delete tier" })[
        screen.getAllByRole("button", { name: "Delete tier" }).length - 1
      ],
    );
    expect(screen.queryByTestId("fallback-tier-group-g1")).toBeNull();
    expect(screen.queryByTestId("fallback-tier-group-g3")).toBeNull();

    // Falsification: have the toast close over a snapshot of `groups` taken
    // AT DELETION TIME and re-submit it whole (the whole-policy-restore-point
    // bug FallbackGroupsInverse replaced) - pressing the FIRST toast's Undo
    // would then also resurrect "g3", which was deleted AFTER it.
    // Inside `act`: this is a bare callback rather than a DOM event, so nothing
    // else flushes the state update it makes before the assertions below read
    // the tree.
    const firstToastCall = toastSuccess.mock.calls[0];
    act(() => {
      firstToastCall[1].action.onClick();
    });

    expect(screen.getByTestId("fallback-tier-group-g1")).not.toBeNull();
    expect(screen.queryByTestId("fallback-tier-group-g3")).toBeNull();
  });
});

describe("FallbackTierGroupsEditor - FC9: preview failure vs absence", () => {
  function renderWith(
    previewPending: boolean,
    previewUnavailable: boolean,
    onRetryPreview: () => void,
  ) {
    const groups: TierGroup[] = [tierGroup("fast", [candidate("opus")])];
    render(
      <Harness
        initialPolicy={{ ...createDefaultFallbackPolicy(), tierGroups: groups }}
        initialGroups={toKeyedGroups(groups)}
        previewUnavailable={previewUnavailable}
        previewPending={previewPending}
        onRetryPreview={onRetryPreview}
      />,
    );
  }

  it("previewUnavailable alone renders the failure message and a working Try again", () => {
    const onRetryPreview = vi.fn();
    renderWith(false, true, onRetryPreview);
    expect(
      screen.getByText("Couldn't check what these models resolve to."),
    ).not.toBeNull();
    fireEvent.click(screen.getByTestId("fallback-tier-preview-retry"));
    expect(onRetryPreview).toHaveBeenCalledTimes(1);
  });

  it("previewPending AND previewUnavailable together render ONLY the pending indicator - the !previewPending term in `failed` is what excludes them", () => {
    renderWith(true, true, vi.fn());
    expect(screen.getByText("Checking what these resolve to…")).not.toBeNull();
    // Falsification: in `PreviewFooterStatus`
    // (`fallback-tier-groups-editor.tsx`), drop the `!previewPending` term from
    // `const failed = !previewPending && previewUnavailable`. Both messages
    // then render together inside the live region, and the announcement
    // contradicts the spinner beside it.
    //
    // That term IS the mutual exclusion now. It used to be the ORDER of two
    // early returns, and this comment named that order until the component was
    // restructured to keep its `role="status"` region mounted across every
    // state - a live region inserted with its content is announced
    // unreliably. Same property, different mechanism, so the mutation moved.
    expect(
      screen.queryByTestId("fallback-tier-preview-unavailable"),
    ).toBeNull();
    expect(
      screen.queryByText("Couldn't check what these models resolve to."),
    ).toBeNull();
  });

  it("D159: with both false, neither the pending indicator nor the failure message renders", () => {
    renderWith(false, false, vi.fn());
    expect(screen.queryByText("Checking what these resolve to…")).toBeNull();
    expect(
      screen.queryByText("Couldn't check what these models resolve to."),
    ).toBeNull();
    expect(
      screen.queryByTestId("fallback-tier-preview-unavailable"),
    ).toBeNull();
  });

  it("the live region is MOUNTED while there is nothing to say, so a later failure is announced rather than inserted", () => {
    renderWith(false, false, vi.fn());
    // The complement of the D159 cell above: no text, and yet the region
    // exists. This is the assertion the announcement depends on - a
    // `role="status"` inserted into the tree together with its content is
    // announced unreliably, so the region has to be there BEFORE the failure
    // text arrives in it.
    //
    // Falsification: revert `PreviewFooterStatus` to returning `null` until
    // `previewUnavailable` and mounting the `role="status"` span with its text
    // already inside. This cell reddens and the other three do not - they
    // assert text and testids, which are identical either way, which is
    // exactly why the live-region shape needs its own pin.
    const region = document.querySelector('[role="status"]');
    expect(region).not.toBeNull();
    expect(region?.textContent ?? "").toBe("");

    // And it is the SAME region the failure text lands in, not a second one.
    cleanup();
    renderWith(false, true, vi.fn());
    const regions = document.querySelectorAll('[role="status"]');
    expect(regions).toHaveLength(1);
    // No `?? ""` here, unlike the `region?.` read above: `noUncheckedIndexedAccess`
    // is off, so `regions[0]` is `Element` rather than `Element | undefined`, and
    // the guard oxlint's `no-unnecessary-condition` sees is a dead one.
    expect(regions[0].textContent).toContain(
      "Couldn't check what these models resolve to.",
    );
  });
});

describe("FallbackTierGroupsEditor - a duplicated group NAME withholds the preview", () => {
  function previewRow(
    groupId: string,
    candidateIndex: number,
    resolvedModel: string,
  ): TierCandidatePreview {
    return {
      groupId,
      candidateIndex,
      harnessId: "claude",
      modelFamily: "opus",
      reasoningEffort: null,
      resolvedModel,
      profileId: null,
      skipReason: null,
      skipLabel: null,
      matches: [],
      warnings: [],
    };
  }

  /**
   * The editor alone, not the stateful `Harness` above: this asserts one
   * render's output, and the harness exists to feed edited groups back in.
   */
  function renderGroups(
    groups: readonly TierGroup[],
    preview: readonly TierCandidatePreview[],
  ): void {
    render(
      <FallbackTierGroupsEditor
        policy={createDefaultFallbackPolicy()}
        groups={toKeyedGroups(groups)}
        preview={preview}
        labelFor={(profileId) => profileId}
        catalog={NO_CATALOG}
        patternsSupported={false}
        conflicts={[]}
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

  it("two groups answering to one name render NO verdict, rather than each other's", () => {
    // The state a rename passes through: "fast" being retyped over "fastest"
    // hits "fast" on the way, and `fallback-tier-group-keys.ts` documents that
    // intermediate duplicates are allowed rather than rejected.
    //
    // Preview rows are identified by `(groupId, candidateIndex)`, so both
    // cards match both rows here and the card's own `previewFor` then picks by
    // `candidateIndex` alone. Without the guard, the SECOND group's single row
    // renders "resolves to claude-opus-4" - the verdict the host computed for
    // the FIRST group's row, on a model family the second group does not even
    // name.
    //
    // Falsification: drop the `ambiguousNames.has(groupId)` line from
    // `previewForGroup`. Two preview lines appear, and the `haiku` row claims
    // to resolve to `claude-opus-4`.
    renderGroups(
      [
        tierGroup("fast", [candidate("opus")]),
        tierGroup("fast", [candidate("haiku")]),
      ],
      [previewRow("fast", 0, "claude-opus-4")],
    );
    expect(
      screen.queryAllByTestId("fallback-tier-candidate-preview"),
    ).toHaveLength(0);
  });

  it("a group whose name is unique still renders its verdict while a SIBLING pair is ambiguous", () => {
    // The control the suppression needs, and the reason it is keyed per NAME
    // rather than per list: suppressing the whole preview whenever any two
    // names collide would blank verdicts on rows nothing is ambiguous about,
    // and the assertion above cannot tell that apart from the fix.
    renderGroups(
      [
        tierGroup("fast", [candidate("opus")]),
        tierGroup("fast", [candidate("haiku")]),
        tierGroup("slow", [candidate("sonnet")]),
      ],
      [
        previewRow("fast", 0, "claude-opus-4"),
        previewRow("slow", 0, "claude-sonnet-4"),
      ],
    );
    const lines = screen.queryAllByTestId("fallback-tier-candidate-preview");
    expect(lines).toHaveLength(1);
    expect(lines[0].textContent).toContain("claude-sonnet-4");
  });
});

describe("FallbackTierGroupsEditor - default tier group", () => {
  /** Radix's select: open with the keyboard, then commit the named option. */
  function openDefaultGroupSelect(): void {
    fireEvent.keyDown(
      screen.getByRole("combobox", { name: "For a model not in any tier" }),
      { key: "ArrowDown" },
    );
  }

  function chooseDefaultGroupOption(name: string): void {
    const item = screen.getByRole("option", { name });
    fireEvent.focus(item);
    fireEvent.keyDown(item, { key: "Enter" });
  }

  it("lists exactly the distinct non-blank group names, plus None, in encounter order", () => {
    const groups: TierGroup[] = [
      tierGroup("fast", []),
      tierGroup("", []),
      tierGroup("cheap", []),
      // A repeat of the first group's name - the state a rename passes
      // through, per `fallback-tier-group-keys.ts`.
      tierGroup("fast", []),
    ];
    render(
      <FallbackTierGroupsEditor
        policy={{ ...createDefaultFallbackPolicy(), tierGroups: groups }}
        groups={toKeyedGroups(groups)}
        preview={null}
        labelFor={(profileId) => profileId}
        catalog={NO_CATALOG}
        patternsSupported={false}
        conflicts={[]}
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
    openDefaultGroupSelect();
    const labels = screen
      .getAllByRole("option")
      .map((option) => option.textContent);
    // Falsification: drop the `names.includes(group.id)` dedupe guard or the
    // blank-name skip from `DefaultGroupSelect` in
    // `fallback-tier-groups-editor.tsx` - a duplicate "fast" or an empty-text
    // option would then appear in this list.
    expect(labels).toEqual(["None - skip this step", "fast", "cheap"]);
  });

  it("choosing a default commits defaultTierGroupId, leaving `groups` the SAME reference", () => {
    const groups: TierGroup[] = [tierGroup("fast", []), tierGroup("cheap", [])];
    const keyedGroups = toKeyedGroups(groups);
    const onCommit = commitSpy();
    render(
      <FallbackTierGroupsEditor
        policy={{ ...createDefaultFallbackPolicy(), tierGroups: groups }}
        groups={keyedGroups}
        preview={null}
        labelFor={(profileId) => profileId}
        catalog={NO_CATALOG}
        patternsSupported={false}
        conflicts={[]}
        previewPending={false}
        previewUnavailable={false}
        onRetryPreview={() => {}}
        onChange={() => {}}
        onCommit={onCommit}
        onUndo={() => {}}
        onRestoreDefaults={() => {}}
        restorePending={false}
        status={null}
        headerAction={null}
        testPanel={null}
      />,
    );
    openDefaultGroupSelect();
    chooseDefaultGroupOption("cheap");
    expect(onCommit).toHaveBeenCalledTimes(1);
    const [committedPolicy, committedGroups] = onCommit.mock.calls[0];
    expect(committedPolicy.defaultTierGroupId).toBe("cheap");
    // Falsification: rebuild the `groups` array (e.g. `[...groups]`) at the
    // `DefaultGroupSelect`'s `onCommit` call site instead of passing the
    // identical `groups` reference through - the doc comment on `onCommit`
    // says both callbacks carry the groups UNCHANGED for this control.
    expect(committedGroups).toBe(keyedGroups);
  });

  it("only the group named by defaultTierGroupId renders the Default pill", () => {
    const groups: TierGroup[] = [tierGroup("fast", []), tierGroup("cheap", [])];
    render(
      <FallbackTierGroupsEditor
        policy={{
          ...createDefaultFallbackPolicy(),
          tierGroups: groups,
          defaultTierGroupId: "cheap",
        }}
        groups={toKeyedGroups(groups)}
        preview={null}
        labelFor={(profileId) => profileId}
        catalog={NO_CATALOG}
        patternsSupported={false}
        conflicts={[]}
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
    // Falsification: pass `isDefault={false}` unconditionally, or compare
    // `policy.defaultTierGroupId` against the group's `draftKey` instead of
    // its `id`, at the `FallbackTierGroupCard` call site in
    // `fallback-tier-groups-editor.tsx` - the pill would then either never
    // appear or attach to the wrong card.
    expect(
      screen
        .getByTestId("fallback-tier-group-fast")
        .querySelector('[data-testid="fallback-tier-group-default"]'),
    ).toBeNull();
    expect(
      screen
        .getByTestId("fallback-tier-group-cheap")
        .querySelector('[data-testid="fallback-tier-group-default"]'),
    ).not.toBeNull();
  });

  it("renaming the DEFAULT group carries the marker on the DRAFT (onChange) path", () => {
    const groups: TierGroup[] = [tierGroup("fast", []), tierGroup("cheap", [])];
    const onChange = commitSpy();
    render(
      <FallbackTierGroupsEditor
        policy={{
          ...createDefaultFallbackPolicy(),
          tierGroups: groups,
          defaultTierGroupId: "fast",
        }}
        groups={toKeyedGroups(groups)}
        preview={null}
        labelFor={(profileId) => profileId}
        catalog={NO_CATALOG}
        patternsSupported={false}
        conflicts={[]}
        previewPending={false}
        previewUnavailable={false}
        onRetryPreview={() => {}}
        onChange={onChange}
        onCommit={() => {}}
        onUndo={() => {}}
        onRestoreDefaults={() => {}}
        restorePending={false}
        status={null}
        headerAction={null}
        testPanel={null}
      />,
    );
    const nameInput =
      screen.getAllByLabelText<HTMLInputElement>("Tier name")[0];
    fireEvent.change(nameInput, { target: { value: "fastest" } });
    // Falsification: drop the carry branch from `replaceGroupAt` in
    // `fallback-tier-groups-editor.tsx` (the
    // `policy.defaultTierGroupId === previous.id && next.id !== previous.id`
    // check) - the emitted policy would keep `defaultTierGroupId: "fast"`, a
    // name no group holds any more the instant this keystroke lands.
    expect(onChange).toHaveBeenCalledTimes(1);
    const [nextPolicy] = onChange.mock.calls[0];
    expect(nextPolicy.defaultTierGroupId).toBe("fastest");
  });

  it("renaming the DEFAULT group also carries the marker on the COMMIT (blur) path", () => {
    const groups: TierGroup[] = [tierGroup("fast", []), tierGroup("cheap", [])];
    const onCommit = commitSpy();
    render(
      <CommitCarryHarness
        initialPolicy={{
          ...createDefaultFallbackPolicy(),
          tierGroups: groups,
          defaultTierGroupId: "fast",
        }}
        initialGroups={toKeyedGroups(groups)}
        onCommit={onCommit}
      />,
    );
    const nameInput =
      screen.getAllByLabelText<HTMLInputElement>("Tier name")[0];
    fireEvent.change(nameInput, { target: { value: "fastest" } });
    fireEvent.blur(nameInput);
    // Falsification: drop the same carry branch from `replaceGroupAt` at the
    // COMMIT call site - the committed policy would keep
    // `defaultTierGroupId: "fast"`, saving a policy the schema's own refine
    // refuses the instant this rename lands (`fallbackPolicySchema`'s
    // `path: ["defaultTierGroupId"]` refine).
    expect(onCommit).toHaveBeenCalledTimes(1);
    const [committedPolicy] = onCommit.mock.calls[0];
    expect(committedPolicy.defaultTierGroupId).toBe("fastest");
  });

  it("deleting the DEFAULT group commits null, and its Undo inverse carries wasDefault: true", () => {
    const groups: TierGroup[] = [tierGroup("fast", []), tierGroup("cheap", [])];
    const onCommit = commitSpy();
    const onUndo = undoSpy();
    render(
      <FallbackTierGroupsEditor
        policy={{
          ...createDefaultFallbackPolicy(),
          tierGroups: groups,
          defaultTierGroupId: "fast",
        }}
        groups={toKeyedGroups(groups)}
        preview={null}
        labelFor={(profileId) => profileId}
        catalog={NO_CATALOG}
        patternsSupported={false}
        conflicts={[]}
        previewPending={false}
        previewUnavailable={false}
        onRetryPreview={() => {}}
        onChange={() => {}}
        onCommit={onCommit}
        onUndo={onUndo}
        onRestoreDefaults={() => {}}
        restorePending={false}
        status={null}
        headerAction={null}
        testPanel={null}
      />,
    );
    // Delete "fast" (index 0), which IS the default.
    fireEvent.click(screen.getAllByRole("button", { name: "Delete tier" })[0]);
    // Falsification: drop the `wasDefault ? { ...policy, defaultTierGroupId:
    // null } : policy` branch from the `onDelete` handler - the committed
    // policy would keep `defaultTierGroupId: "fast"`, a name the deleted
    // group no longer holds, which the schema then refuses to save.
    expect(onCommit).toHaveBeenCalledTimes(1);
    const [committedPolicy] = onCommit.mock.calls[0];
    expect(committedPolicy.defaultTierGroupId).toBeNull();

    expect(toastSuccess).toHaveBeenCalledTimes(1);
    const toastCall = toastSuccess.mock.calls[0];
    act(() => {
      toastCall[1].action.onClick();
    });
    // Falsification: drop `wasDefault` from the inverse object built at the
    // toast's Undo callback - Undo would then always report `wasDefault:
    // false` (or `undefined`), losing that this group was the default when
    // it was removed.
    expect(onUndo).toHaveBeenCalledTimes(1);
    const [inverse] = onUndo.mock.calls[0];
    expect(inverse.kind).toBe("group");
    expect(inverse.kind === "group" ? inverse.wasDefault : null).toBe(true);
  });

  it("deleting a NON-default group's Undo inverse carries wasDefault: false", () => {
    const groups: TierGroup[] = [tierGroup("fast", []), tierGroup("cheap", [])];
    const onUndo = undoSpy();
    render(
      <FallbackTierGroupsEditor
        policy={{
          ...createDefaultFallbackPolicy(),
          tierGroups: groups,
          defaultTierGroupId: "fast",
        }}
        groups={toKeyedGroups(groups)}
        preview={null}
        labelFor={(profileId) => profileId}
        catalog={NO_CATALOG}
        patternsSupported={false}
        conflicts={[]}
        previewPending={false}
        previewUnavailable={false}
        onRetryPreview={() => {}}
        onChange={() => {}}
        onCommit={() => {}}
        onUndo={onUndo}
        onRestoreDefaults={() => {}}
        restorePending={false}
        status={null}
        headerAction={null}
        testPanel={null}
      />,
    );
    // Delete "cheap" (index 1), which is NOT the default.
    fireEvent.click(screen.getAllByRole("button", { name: "Delete tier" })[1]);
    const toastCall = toastSuccess.mock.calls[0];
    act(() => {
      toastCall[1].action.onClick();
    });
    // The control for the cell above: without it, a reducer that always
    // reports `wasDefault: true` would satisfy that assertion trivially.
    expect(onUndo).toHaveBeenCalledTimes(1);
    const [inverse] = onUndo.mock.calls[0];
    expect(inverse.kind).toBe("group");
    expect(inverse.kind === "group" ? inverse.wasDefault : null).toBe(false);
  });

  it("'Add tier' emits the policy UNCHANGED apart from the appended group - defaultTierGroupId untouched", () => {
    const groups: TierGroup[] = [tierGroup("fast", [])];
    const keyedGroups = toKeyedGroups(groups);
    const onCommit = commitSpy();
    render(
      <FallbackTierGroupsEditor
        policy={{
          ...createDefaultFallbackPolicy(),
          tierGroups: groups,
          defaultTierGroupId: "fast",
        }}
        groups={keyedGroups}
        preview={null}
        labelFor={(profileId) => profileId}
        catalog={NO_CATALOG}
        patternsSupported={false}
        conflicts={[]}
        previewPending={false}
        previewUnavailable={false}
        onRetryPreview={() => {}}
        onChange={() => {}}
        onCommit={onCommit}
        onUndo={() => {}}
        onRestoreDefaults={() => {}}
        restorePending={false}
        status={null}
        headerAction={null}
        testPanel={null}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Add tier" }));
    expect(onCommit).toHaveBeenCalledTimes(1);
    const [committedPolicy, committedGroups] = onCommit.mock.calls[0];
    // Falsification: rebuild the policy (rather than passing the untouched
    // `policy` reference through `withTierGroups`) at the "Add tier"
    // click handler - `defaultTierGroupId` (or any other field) could then
    // drift on a purely additive edit that named nothing about it.
    expect(committedPolicy.defaultTierGroupId).toBe("fast");
    expect(committedGroups).toHaveLength(2);
    expect(committedGroups[0]).toBe(keyedGroups[0]);
    expect(committedGroups[1].id).toBe("New tier");
  });

  it("the default-group select does not render when groups is empty - the EmptyGroups branch", () => {
    render(
      <FallbackTierGroupsEditor
        policy={createDefaultFallbackPolicy()}
        groups={[]}
        preview={null}
        labelFor={(profileId) => profileId}
        catalog={NO_CATALOG}
        patternsSupported={false}
        conflicts={[]}
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
    // Falsification: render `DefaultGroupSelect` unconditionally instead of
    // gating it on `groups.length === 0` in `FallbackTierGroupsEditor` - a
    // combobox with nothing to name a default FOR would then render over the
    // "Restore the default groups" empty state.
    expect(screen.queryByTestId("fallback-tier-default-group")).toBeNull();
    expect(screen.getByTestId("fallback-tier-groups-empty")).not.toBeNull();
  });
});

/**
 * A local wrapper for the P2 pin below, cast from the same mold as `Harness`
 * and `CommitCarryHarness` above: `onChange` feeds the draft straight back
 * into state, so a rename's SECOND keystroke is genuinely evaluated against
 * the group list the FIRST one produced - which is exactly what
 * `replaceGroupAt` reads `previous` off of. It differs from `Harness` in
 * exposing what it emits, via `onEmit`, rather than only through the DOM:
 * this pin's own assertion is on the policy object the editor hands up, not
 * on a rendered proxy for it.
 */
function RenameCarryHarness(props: {
  readonly initialPolicy: FallbackPolicy;
  readonly initialGroups: readonly KeyedGroup[];
  readonly onEmit: (
    policy: FallbackPolicy,
    groups: readonly KeyedGroup[],
  ) => void;
}): ReactNode {
  const [policy, setPolicy] = useState(props.initialPolicy);
  const [groups, setGroups] = useState(props.initialGroups);
  const adopt = (
    nextPolicy: FallbackPolicy,
    nextGroups: readonly KeyedGroup[],
  ): void => {
    setPolicy(nextPolicy);
    setGroups(nextGroups);
    props.onEmit(nextPolicy, nextGroups);
  };
  return (
    <FallbackTierGroupsEditor
      policy={policy}
      groups={groups}
      preview={null}
      labelFor={(profileId) => profileId}
      catalog={NO_CATALOG}
      patternsSupported={false}
      conflicts={[]}
      previewPending={false}
      previewUnavailable={false}
      onRetryPreview={() => {}}
      onChange={adopt}
      onCommit={adopt}
      onUndo={() => {}}
      onRestoreDefaults={() => {}}
      restorePending={false}
      status={null}
      headerAction={null}
      testPanel={null}
    />
  );
}

describe("FallbackTierGroupsEditor - P2 a rename must not steal the default marker from another group", () => {
  it("the marker stays with the group the user made the default, not with a sibling whose rename passes through its name", () => {
    const groups: TierGroup[] = [tierGroup("fast", []), tierGroup("cheap", [])];
    let lastPolicy: FallbackPolicy = {
      ...createDefaultFallbackPolicy(),
      tierGroups: groups,
      defaultTierGroupId: "fast",
    };
    render(
      <RenameCarryHarness
        initialPolicy={lastPolicy}
        initialGroups={toKeyedGroups(groups)}
        onEmit={(policy) => {
          lastPolicy = policy;
        }}
      />,
    );
    const nameInputs = () =>
      screen.getAllByLabelText<HTMLInputElement>("Tier name");

    // Rename "cheap" (index 1, never the default) so its value passes
    // THROUGH "fast" - the default's own name - on the way to "faster". The
    // bug needs at least two successive changes: one that lands EXACTLY on
    // the default's name, and a following one that moves past it.
    fireEvent.change(nameInputs()[1], { target: { value: "fast" } });
    // Admission evidence: the first keystroke alone does not move the
    // marker - it is the SECOND one, landing while group 1's name reads
    // "fast", that a name-based comparison would misjudge.
    expect(lastPolicy.defaultTierGroupId).toBe("fast");
    expect(lastPolicy.tierGroups.map((group) => group.id)).toEqual([
      "fast",
      "fast",
    ]);

    fireEvent.change(nameInputs()[1], { target: { value: "faster" } });

    // Falsification: revert `replaceGroupAt` in
    // `fallback-tier-groups-editor.tsx` to compare by NAME
    // (`policy.defaultTierGroupId === previous.id`) instead of by the
    // POSITION `defaultTierGroupIndex` supplies. At the second change above,
    // `previous.id` (group 1's name going INTO that keystroke) reads "fast" -
    // the true default's own name - so a name-based `replaceGroupAt` reads
    // this as "the default is being renamed" and carries the marker onto
    // "faster", even though index 1 was never the default index (0).
    expect(lastPolicy.defaultTierGroupId).toBe("fast");
    expect(lastPolicy.defaultTierGroupId).not.toBe("faster");
    expect(lastPolicy.tierGroups.map((group) => group.id)).toEqual([
      "fast",
      "faster",
    ]);
  });
});

/**
 * A props-driven wrapper for Pin 8 - three tiers, "Restore the default
 * tiers" now behind a confirm rather than the empty state's direct call.
 * `restorePending` is driven by RERENDER, not internal state, for the same
 * reason `fallback-danger-zone.test.tsx`'s `renderResetHarness` gives: writing
 * an outer-variable setter during render is banned outright
 * (`clients/gui-app/AGENTS.md`), and `restorePending` really is a controlled
 * prop in production - the panel derives it from the mutation.
 */
function RestoreHarness(props: {
  readonly restorePending: boolean;
  readonly onRestoreDefaults: () => void;
  readonly patternsSupported: boolean;
}): ReactNode {
  const groups: TierGroup[] = [
    tierGroup("frontier", []),
    tierGroup("flagship", []),
    tierGroup("standard", []),
  ];
  return (
    <FallbackTierGroupsEditor
      policy={{ ...createDefaultFallbackPolicy(), tierGroups: groups }}
      groups={toKeyedGroups(groups)}
      preview={null}
      labelFor={(profileId) => profileId}
      catalog={NO_CATALOG}
      patternsSupported={props.patternsSupported}
      conflicts={[]}
      previewPending={false}
      previewUnavailable={false}
      onRetryPreview={() => {}}
      onChange={() => {}}
      onCommit={() => {}}
      onUndo={() => {}}
      onRestoreDefaults={props.onRestoreDefaults}
      restorePending={props.restorePending}
      status={null}
      headerAction={null}
      testPanel={null}
    />
  );
}

describe("FallbackTierGroupsEditor - Pin 8: 'Restore the default tiers' confirm flow", () => {
  it("opens with the exact tier-count title and the 'sets the default tier to flagship' description, without calling onRestoreDefaults on open", () => {
    const onRestoreDefaults = vi.fn();
    render(
      <RestoreHarness
        restorePending={false}
        onRestoreDefaults={onRestoreDefaults}
        patternsSupported
      />,
    );
    fireEvent.click(screen.getByTestId("fallback-tier-groups-restore"));
    // Falsification: `RestoreDefaultTiers`'s dialog `title` template
    // (`fallback-tier-groups-editor.tsx`) - change the count interpolation, or
    // drop the singular/plural branch, and this exact string goes stale.
    expect(
      screen.getByText(
        "Replace your 3 tiers with the default Frontier, Flagship and Standard tiers?",
      ),
    ).not.toBeNull();
    expect(
      screen.getByText("This also sets the default tier to flagship."),
    ).not.toBeNull();
    expect(onRestoreDefaults).not.toHaveBeenCalled();
  });

  it("Cancel leaves the tiers untouched, calls onRestoreDefaults zero times, and returns focus to the Restore button", async () => {
    const onRestoreDefaults = vi.fn();
    render(
      <RestoreHarness
        restorePending={false}
        onRestoreDefaults={onRestoreDefaults}
        patternsSupported
      />,
    );
    const restoreButton = screen.getByTestId("fallback-tier-groups-restore");
    // `fireEvent.click` does not itself move focus the way a real pointer
    // click does - `confirm-destructive-dialog.test.tsx` pins the same
    // `.focus()`-before-click precondition for this dialog's opener capture.
    restoreButton.focus();
    fireEvent.click(restoreButton);
    fireEvent.click(screen.getByTestId("confirm-cancel"));
    // Falsification: call `onRestoreDefaults` from `onOpenChange` instead of
    // only from the dialog's `onConfirm` - Cancel would then also restore.
    expect(onRestoreDefaults).not.toHaveBeenCalled();
    expect(screen.getByTestId("fallback-tier-group-frontier")).not.toBeNull();
    expect(screen.getByTestId("fallback-tier-group-flagship")).not.toBeNull();
    expect(screen.getByTestId("fallback-tier-group-standard")).not.toBeNull();
    // The shared `ConfirmDestructiveDialog`'s own opener-restore mechanism
    // (`confirm-destructive-dialog.tsx`'s `openerRef`) runs its
    // `onCloseAutoFocus` from a deferred `setTimeout(0)` - a Cancel or Escape
    // returns the keyboard to whatever control opened it, but only once that
    // macrotask has run.
    await waitFor(() => {
      expect(document.activeElement).toBe(restoreButton);
    });
  });

  it("Confirm calls onRestoreDefaults exactly once and, once the round trip settles, moves focus off the closed dialog", async () => {
    const onRestoreDefaults = vi.fn();
    const view = render(
      <RestoreHarness
        restorePending={false}
        onRestoreDefaults={onRestoreDefaults}
        patternsSupported
      />,
    );
    fireEvent.click(screen.getByTestId("fallback-tier-groups-restore"));
    fireEvent.click(screen.getByTestId("confirm-action"));
    // Falsification: gate the call behind a second confirmation, or fold it
    // into `onOpenChange` where a programmatic close would also fire it.
    expect(onRestoreDefaults).toHaveBeenCalledTimes(1);

    // The parent starts the mutation in the SAME gesture that confirms - the
    // sequence `fallback-danger-zone.test.tsx`'s R-OSS-2 cell exercises, and
    // for the same reason: Radix's own `onCloseAutoFocus` runs against an
    // opener that is already `disabled={isPending}` and silently no-ops,
    // landing focus on `document.body`.
    act(() => {
      view.rerender(
        <RestoreHarness
          restorePending
          onRestoreDefaults={onRestoreDefaults}
          patternsSupported
        />,
      );
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    // Admission evidence: Radix really did leave the keyboard nowhere useful
    // once the opener it tried to restore to was disabled.
    expect(document.activeElement).toBe(document.body);

    act(() => {
      view.rerender(
        <RestoreHarness
          restorePending={false}
          onRestoreDefaults={onRestoreDefaults}
          patternsSupported
        />,
      );
    });
    // Falsification: delete the `useEffect` in `RestoreDefaultTiers` that
    // watches `restorePending` falling - nothing would then move focus once
    // the restore settles, and `document.activeElement` would stay stuck on
    // `document.body`, the state Radix's own attempt left it in above.
    await waitFor(() => {
      const restoreButton = screen.getByRole("button", {
        name: "Restore the default tiers",
      });
      expect(restoreButton.hasAttribute("disabled")).toBe(false);
      expect(document.activeElement).not.toBe(document.body);
    });
  });

  it("the empty state's OWN 'Restore the default tiers' button calls onRestoreDefaults DIRECTLY, with no dialog appearing", () => {
    const onRestoreDefaults = vi.fn();
    render(
      <FallbackTierGroupsEditor
        policy={createDefaultFallbackPolicy()}
        groups={[]}
        preview={null}
        labelFor={(profileId) => profileId}
        catalog={NO_CATALOG}
        patternsSupported={false}
        conflicts={[]}
        previewPending={false}
        previewUnavailable={false}
        onRetryPreview={() => {}}
        onChange={() => {}}
        onCommit={() => {}}
        onUndo={() => {}}
        onRestoreDefaults={onRestoreDefaults}
        restorePending={false}
        status={null}
        headerAction={null}
        testPanel={null}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Restore the default tiers" }),
    );
    // Falsification: route the empty state's button through
    // `RestoreDefaultTiers` (the confirming variant) instead of `EmptyGroups`
    // calling `onRestoreDefaults` directly - a confirm dialog would then
    // appear where there is nothing yet to lose.
    expect(onRestoreDefaults).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("confirm-destructive-dialog")).toBeNull();
  });
});

/**
 * R5 - the populated-list footer "Restore the default tiers" currently
 * renders on every host (`groups.length === 0 ? null : <RestoreDefaultTiers …
 * />` in `fallback-tier-groups-editor.tsx`, with no `patternsSupported`
 * check). A get@1.0 host's restore writes the OLD two tiers and KEEPS the
 * existing default, and REJECTS the restore when the default names a custom
 * tier - so the confirm's promise ("the default Frontier, Flagship and
 * Standard tiers", "sets the default tier to flagship") is false on that
 * host, and the released GUI never offered this footer control at all. The
 * fix renders it only when `patternsSupported` is true; the empty state's
 * direct button is unaffected (GUARD E).
 */
describe("FallbackTierGroupsEditor - R5: a get@1.0 host keeps the released populated-list behaviour", () => {
  function legacyGroups(): TierGroup[] {
    return [tierGroup("frontier", []), tierGroup("standard", [])];
  }

  function legacyGroupsWithCustomDefault(): TierGroup[] {
    return [
      tierGroup("frontier", []),
      tierGroup("standard", []),
      tierGroup("cheap", []),
    ];
  }

  function renderEditor(props: {
    readonly patternsSupported: boolean;
    readonly groups: readonly TierGroup[];
    readonly defaultTierGroupId: string | null;
    readonly onRestoreDefaults: () => void;
  }): RenderResult {
    return render(
      <FallbackTierGroupsEditor
        policy={{
          ...createDefaultFallbackPolicy(),
          tierGroups: [...props.groups],
          defaultTierGroupId: props.defaultTierGroupId,
        }}
        groups={toKeyedGroups(props.groups)}
        preview={null}
        labelFor={(profileId) => profileId}
        catalog={NO_CATALOG}
        patternsSupported={props.patternsSupported}
        conflicts={[]}
        previewPending={false}
        previewUnavailable={false}
        onRetryPreview={() => {}}
        onChange={() => {}}
        onCommit={() => {}}
        onUndo={() => {}}
        onRestoreDefaults={props.onRestoreDefaults}
        restorePending={false}
        status={null}
        headerAction={null}
        testPanel={null}
      />,
    );
  }

  it("RED 3: patternsSupported false, a legacy two-tier policy with no custom default - no footer restore control", () => {
    renderEditor({
      patternsSupported: false,
      groups: legacyGroups(),
      defaultTierGroupId: null,
      onRestoreDefaults: () => {},
    });
    // Falsification: this is RED on the unmodified editor, which renders
    // `RestoreDefaultTiers` whenever `groups.length > 0` with no
    // `patternsSupported` check at all.
    expect(screen.queryByTestId("fallback-tier-groups-restore")).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Restore the default tiers" }),
    ).toBeNull();
  });

  it("RED 4: patternsSupported false, a custom tier as the default - still no footer restore control, and it is never invoked", () => {
    const onRestoreDefaults = vi.fn();
    renderEditor({
      patternsSupported: false,
      groups: legacyGroupsWithCustomDefault(),
      defaultTierGroupId: "cheap",
      onRestoreDefaults,
    });
    // Falsification: same as RED 3. A get@1.0 host's restore also REJECTS
    // outright here, because the default names a tier the released two-tier
    // seed does not have - this case is where offering the control is worst.
    expect(screen.queryByTestId("fallback-tier-groups-restore")).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Restore the default tiers" }),
    ).toBeNull();
    expect(onRestoreDefaults).toHaveBeenCalledTimes(0);
  });

  it("GUARD E: patternsSupported false, the EMPTY state's own direct button is unaffected - one click, no confirm dialog", () => {
    const onRestoreDefaults = vi.fn();
    renderEditor({
      patternsSupported: false,
      groups: [],
      defaultTierGroupId: null,
      onRestoreDefaults,
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Restore the default tiers" }),
    );
    // The empty state (`EmptyGroups`) is a different component from the
    // footer `RestoreDefaultTiers` this describe is about, and it calls
    // `onRestoreDefaults` directly with no confirm - unchanged by the
    // `patternsSupported` gate the fix adds to the footer alone.
    expect(onRestoreDefaults).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("confirm-destructive-dialog")).toBeNull();
  });

  it("GUARD F: patternsSupported true, a custom tier as the default - the footer restore IS present, and opening it shows the Frontier/Flagship/Standard title", () => {
    renderEditor({
      patternsSupported: true,
      groups: legacyGroupsWithCustomDefault(),
      defaultTierGroupId: "cheap",
      onRestoreDefaults: () => {},
    });
    const restoreButton = screen.getByTestId("fallback-tier-groups-restore");
    fireEvent.click(restoreButton);
    // Falsification: gate the footer on something other than
    // `patternsSupported` (e.g. always render it) - this guard would still
    // pass, but RED 3/4 above would catch that instead; gate it the OTHER
    // way (render only when `patternsSupported` is false) and this guard is
    // what catches a 1.1 host silently losing its own restore control.
    expect(
      screen.getByText(
        "Replace your 3 tiers with the default Frontier, Flagship and Standard tiers?",
      ),
    ).not.toBeNull();
  });
});

/**
 * The ticket's Done-when lines, end to end, against the real seeded policy
 * (`fallback-tier-seed.ts`'s literals) and the real `fallbackTierConflicts` -
 * not a hand-built `TierConflict`, so this cannot silently drift from what
 * the protocol actually computes. Every test here fails on the pre-ticket
 * editor: it has no combobox at all (the Model cell was a bare `Select`), no
 * `role="status"` announcement span, and "group"/"family" copy instead of
 * "tier"/"pattern".
 */
describe("FallbackTierGroupsEditor - seeded three-tier policy, end to end", () => {
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

  const HIGH: readonly AgentReasoningEffortOption[] = [effort("high", "High")];
  const MEDIUM: readonly AgentReasoningEffortOption[] = [
    effort("medium", "Medium"),
  ];

  /** codex catalog per the coordinator's spec - gpt-6-luna/-mini both contain "luna". */
  function codexCatalog(): readonly GuiAgentModelOption[] {
    return [
      model("codex", "gpt-6-astra", "GPT-6-Astra", HIGH),
      model("codex", "gpt-6-sol", "GPT-6-Sol", HIGH),
      model("codex", "gpt-6-luna", "GPT-6-Luna", HIGH),
      model("codex", "gpt-6-luna-mini", "GPT-6-Luna Mini", HIGH),
      model("codex", "gpt-5.6-terra", "GPT-5.6-Terra", MEDIUM),
    ];
  }

  function claudeCatalog(): readonly GuiAgentModelOption[] {
    return [
      model("claude", "claude-fable-5-1", "Fable 5.1", HIGH),
      model("claude", "opus", "Opus 5.5", HIGH),
      model("claude", "sonnet", "Sonnet 5", []),
    ];
  }

  function catalogsByHarness(): ReadonlyMap<
    HarnessId,
    readonly GuiAgentModelOption[]
  > {
    return new Map([
      ["codex", codexCatalog()],
      ["claude", claudeCatalog()],
    ]);
  }

  function seededCatalog(): FallbackCatalogOptions {
    const byHarness = catalogsByHarness();
    return {
      modelsFor: (harnessId) => byHarness.get(harnessId) ?? [],
      catalogFor: (harnessId) => byHarness.get(harnessId) ?? null,
      catalogsByHarness: byHarness,
      effortsFor: (harnessId, modelFamily) => {
        const models = byHarness.get(harnessId) ?? [];
        const picked = catalogModelForFamily(models, modelFamily);
        return picked === null ? [] : picked.supportedReasoningEfforts;
      },
    };
  }

  /**
   * The seeded three tiers, exactly `fallback-tier-seed.ts`'s literals, with
   * an optional extra blank row appended to `standard` - the "blank codex
   * row" the picker pins below need, seeded directly rather than added
   * through "Add model or pattern" (equivalent per the ticket's own wording,
   * and it sidesteps switching the new row's Provider select away from the
   * global `firstHarnessId` default).
   */
  function seededGroups(
    extraStandardCandidate: TierCandidate | null,
  ): TierGroup[] {
    return [
      {
        id: "frontier",
        candidates: [
          {
            harnessId: "claude",
            modelFamily: "*fable*",
            reasoningEffort: "high",
          },
          {
            harnessId: "codex",
            modelFamily: "*astra*",
            reasoningEffort: "high",
          },
        ],
      },
      {
        id: "flagship",
        candidates: [
          {
            harnessId: "claude",
            modelFamily: "*opus*",
            reasoningEffort: "high",
          },
          { harnessId: "codex", modelFamily: "*sol*", reasoningEffort: "high" },
          { harnessId: "grok", modelFamily: "*grok*", reasoningEffort: null },
        ],
      },
      {
        id: "standard",
        candidates: [
          {
            harnessId: "claude",
            modelFamily: "*sonnet*",
            reasoningEffort: null,
          },
          {
            harnessId: "codex",
            modelFamily: "*terra*",
            reasoningEffort: "medium",
          },
          ...(extraStandardCandidate === null ? [] : [extraStandardCandidate]),
        ],
      },
    ];
  }

  /**
   * Controlled by the editor's own `onChange`/`onCommit`, like `Harness`
   * above, plus `conflicts` recomputed from the REAL `fallbackTierConflicts`
   * on every state change - so a picker choice that changes what conflicts
   * exist is reflected the same way the panel reflects it.
   */
  function SeededEditorHarness(props: {
    readonly groups: readonly TierGroup[];
    readonly onCommit: (
      policy: FallbackPolicy,
      groups: readonly KeyedGroup[],
    ) => void;
  }): ReactNode {
    const [state, setState] = useState<{
      readonly policy: FallbackPolicy;
      readonly groups: readonly KeyedGroup[];
    }>(() => ({
      policy: {
        ...createDefaultFallbackPolicy(),
        tierGroups: [...props.groups],
        defaultTierGroupId: "flagship",
      },
      groups: toKeyedGroups(props.groups),
    }));
    const conflicts = fallbackTierConflicts(
      state.policy.tierGroups,
      catalogsByHarness(),
    );
    return (
      <FallbackTierGroupsEditor
        policy={state.policy}
        groups={state.groups}
        preview={null}
        labelFor={(profileId) => profileId}
        catalog={seededCatalog()}
        patternsSupported
        conflicts={conflicts}
        previewPending={false}
        previewUnavailable={false}
        onRetryPreview={() => {}}
        onChange={(next, groups) => {
          setState({ policy: next, groups });
        }}
        onCommit={(next, groups) => {
          setState({ policy: next, groups });
          props.onCommit(next, groups);
        }}
        onUndo={() => {}}
        onRestoreDefaults={() => {}}
        restorePending={false}
        status={null}
        headerAction={null}
        testPanel={null}
      />
    );
  }

  it("1. renders three tier cards in seed order, the Default pill on flagship only, and the default-tier select showing flagship", () => {
    render(
      <SeededEditorHarness groups={seededGroups(null)} onCommit={vi.fn()} />,
    );
    const cardTestIds = screen
      .getAllByTestId(/^fallback-tier-group-(frontier|flagship|standard)$/)
      .map((card) => card.getAttribute("data-testid"));
    // Falsification: the pre-ticket editor renders "group"-copy cards with no
    // such testids at all - this whole suite reddens on it. Kept precise
    // (exact order, exactly these three) so a future seed reorder is also
    // caught here, not only in the host-side seed test.
    expect(cardTestIds).toEqual([
      "fallback-tier-group-frontier",
      "fallback-tier-group-flagship",
      "fallback-tier-group-standard",
    ]);
    expect(
      within(screen.getByTestId("fallback-tier-group-frontier")).queryByTestId(
        "fallback-tier-group-default",
      ),
    ).toBeNull();
    expect(
      within(screen.getByTestId("fallback-tier-group-flagship")).queryByTestId(
        "fallback-tier-group-default",
      ),
    ).not.toBeNull();
    expect(
      within(screen.getByTestId("fallback-tier-group-standard")).queryByTestId(
        "fallback-tier-group-default",
      ),
    ).toBeNull();
    expect(
      screen.getByRole("combobox", { name: "For a model not in any tier" })
        .textContent,
    ).toBe("flagship");
  });

  it('2. typing "luna" in a blank codex row of standard offers \'Any model containing "luna"\' (2 models) and commits *luna*', () => {
    const onCommit =
      vi.fn<(policy: FallbackPolicy, groups: readonly KeyedGroup[]) => void>();
    render(
      <SeededEditorHarness
        groups={seededGroups({
          harnessId: "codex",
          modelFamily: "",
          reasoningEffort: null,
        })}
        onCommit={onCommit}
      />,
    );
    const standardCard = screen.getByTestId("fallback-tier-group-standard");
    const triggers = within(standardCard).getAllByTestId(
      "fallback-model-pattern-trigger",
    );
    // The blank row is the one just appended - the last of standard's three.
    const blankTrigger = triggers[triggers.length - 1];
    fireEvent.click(blankTrigger);
    const input = screen.getByTestId(
      "fallback-model-pattern-input",
    ) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "luna" } });
    const patternOption = screen.getByTestId("fallback-model-pattern-option");
    // Falsification: `CONTAINS_MIN_LENGTH` raised past 4, or the codex
    // fixture missing `gpt-6-luna-mini` - either would change this count away
    // from "2 models".
    expect(patternOption.textContent).toContain("Any model containing");
    expect(patternOption.textContent).toContain("luna");
    expect(patternOption.textContent).toContain("2 models");
    // The pattern entry is already highlighted (no exact match for "luna"),
    // so Enter alone commits it - the coordinator's own semantics, exercised
    // here through the full editor rather than the bare combobox.
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onCommit).toHaveBeenCalledTimes(1);
    const [committedPolicy] = onCommit.mock.calls[0];
    const committedStandard = committedPolicy.tierGroups.find(
      (group) => group.id === "standard",
    );
    expect(committedStandard).toBeDefined();
    if (committedStandard === undefined) return;
    // Asserted on the COMMITTED POLICY, not a callback prop of the combobox -
    // the coordinator's own instruction, since the combobox's own `onChange`
    // contract is already pinned in isolation elsewhere.
    expect(
      committedStandard.candidates[committedStandard.candidates.length - 1],
    ).toEqual({
      harnessId: "codex",
      modelFamily: "*luna*",
      reasoningEffort: null,
    });
  });

  it('3. typing "gpt-6-*" in the same kind of row is refused: no commit, and the live region says why; a second Enter re-announces (new node)', () => {
    const onCommit =
      vi.fn<(policy: FallbackPolicy, groups: readonly KeyedGroup[]) => void>();
    render(
      <SeededEditorHarness
        groups={seededGroups({
          harnessId: "codex",
          modelFamily: "",
          reasoningEffort: null,
        })}
        onCommit={onCommit}
      />,
    );
    const standardCard = screen.getByTestId("fallback-tier-group-standard");
    const triggers = within(standardCard).getAllByTestId(
      "fallback-model-pattern-trigger",
    );
    const blankTrigger = triggers[triggers.length - 1];
    fireEvent.click(blankTrigger);
    const input = screen.getByTestId(
      "fallback-model-pattern-input",
    ) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "gpt-6-*" } });
    fireEvent.keyDown(input, { key: "Enter" });
    // Falsification: no commit happens on a refused choice - `choose()`'s
    // `entry.blockers.length > 0` guard, already pinned against the bare
    // combobox in `fallback-model-pattern-combobox.test.tsx`.
    expect(onCommit).not.toHaveBeenCalled();
    const region = screen.getByTestId("fallback-tier-picker-announcement");
    expect(region.closest('[role="status"]')).not.toBeNull();
    // Falsification: this is the EDITOR's OWN wiring - `onAnnounce={announce}`
    // at the `FallbackTierGroupCard` call site in
    // `fallback-tier-groups-editor.tsx` - not the combobox's own `onAnnounce`
    // prop the file above already pins in isolation. Passing a no-op there
    // instead of `announce` leaves the picker's refusal correct and this
    // region empty; verified by reversion (see the report back to the
    // coordinator) and restored byte-identical.
    expect(region.textContent).toContain(
      "GPT-6-Astra is in frontier and GPT-6-Sol is in flagship",
    );

    fireEvent.keyDown(input, { key: "Enter" });
    const secondRegion = screen.getByTestId(
      "fallback-tier-picker-announcement",
    );
    // Falsification: drop `key={announcement.count}` from the live region's
    // span (`PreviewFooterStatus` in `fallback-tier-groups-editor.tsx`) -
    // React would then patch the SAME node's text on a repeated refusal
    // rather than mounting a new one, which is indistinguishable from "no
    // change" to a screen reader.
    expect(secondRegion).not.toBe(region);
    expect(onCommit).not.toHaveBeenCalled();
  });
});

/**
 * Ticket 05, clause 7: the `testPanel` render-prop slot (`TestPanelSlot`) and
 * the `headerAction` slot beside it. `TestPanelSlot` exists because the render
 * function needs `goToRow` as a PROP rather than called inline mid-render (see
 * that component's own doc comment) - moved there after the React compiler
 * lint flagged the inline call.
 */
describe("FallbackTierGroupsEditor - the Test a model slot (ticket 05)", () => {
  function twoTierGroups(): readonly TierGroup[] {
    return [
      tierGroup("frontier", [candidate("opus")]),
      tierGroup("standard", [candidate("sonnet")]),
    ];
  }

  function renderEditor(props: {
    readonly headerAction?: ReactNode;
    readonly testPanel: FallbackTierGroupsEditorProps["testPanel"];
  }): void {
    const groups = twoTierGroups();
    const policy: FallbackPolicy = {
      ...createDefaultFallbackPolicy(),
      tierGroups: [...groups],
    };
    render(
      <FallbackTierGroupsEditor
        policy={policy}
        groups={toKeyedGroups(groups)}
        preview={null}
        labelFor={(profileId) => profileId}
        catalog={NO_CATALOG}
        patternsSupported
        conflicts={[]}
        previewPending={false}
        previewUnavailable={false}
        onRetryPreview={() => {}}
        onChange={() => {}}
        onCommit={() => {}}
        onUndo={() => {}}
        onRestoreDefaults={() => {}}
        restorePending={false}
        status={null}
        headerAction={props.headerAction ?? null}
        testPanel={props.testPanel}
      />,
    );
  }

  it("calls the render prop with goToRow, rendered directly under the header, and clicking through it focuses the OTHER tier's Model cell", () => {
    renderEditor({
      testPanel: (goToRow) => (
        <button type="button" onClick={() => goToRow(1, 0)}>
          go
        </button>
      ),
    });
    const header = screen.getByTestId("fallback-tier-groups-header");
    const button = screen.getByRole("button", { name: "go" });
    // `TestPanelSlot` renders the function's own result with no wrapper, right
    // after the header - the same position the real Test a model panel draws
    // in (wireframe 1).
    expect(header.nextElementSibling).toBe(button);

    const standardCard = screen.getByTestId("fallback-tier-group-standard");
    const standardTrigger = within(standardCard).getByTestId(
      "fallback-model-pattern-trigger",
    );
    fireEvent.click(button);
    // Falsification: the same focus target the conflict block's own "Go to
    // the <tier> row" pins in `fallback-tier-group-card.test.tsx` - both reach
    // the SAME `goToRow` on the editor, so a regression in either caller's
    // wiring would show up as focus landing anywhere other than this trigger.
    expect(document.activeElement).toBe(standardTrigger);
  });

  it("renders headerAction inside fallback-tier-groups-header, beside the intro", () => {
    renderEditor({
      headerAction: <span data-testid="test-header-action" />,
      testPanel: null,
    });
    const header = screen.getByTestId("fallback-tier-groups-header");
    within(header).getByTestId("test-header-action");
  });

  it("renders nothing between the header and the groups when testPanel is null", () => {
    renderEditor({ testPanel: null });
    const header = screen.getByTestId("fallback-tier-groups-header");
    // With no test panel, the header's very next sibling is the default-tier
    // control - nothing from the slot sits between them.
    expect(header.nextElementSibling?.getAttribute("data-testid")).toBe(
      "fallback-tier-default-group",
    );
  });
});
