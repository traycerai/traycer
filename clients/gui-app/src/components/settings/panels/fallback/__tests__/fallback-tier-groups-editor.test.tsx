import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createDefaultFallbackPolicy,
  type FallbackPolicy,
  type TierCandidate,
  type TierCandidatePreview,
  type TierGroup,
} from "@traycer/protocol/host/fallback-policy";
import {
  applyGroupsInverse,
  toKeyedGroups,
  withTierGroups,
  type FallbackGroupsInverse,
  type KeyedGroup,
} from "@/components/settings/panels/fallback/fallback-tier-group-keys";
import type { FallbackEffortOptions } from "@/components/settings/panels/fallback/fallback-effort-options";
import { FallbackTierGroupsEditor } from "@/components/settings/panels/fallback/fallback-tier-groups-editor";

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

// R6: the card's Model family field is `FallbackModelFamilyInput`, which
// queries the harness catalog. `data: undefined` means "no cached catalog",
// under which the component renders a plain textbox with no datalist - every
// existing family-input query in this suite keeps working unchanged.
vi.mock("@/hooks/harnesses/use-gui-harness-catalog", () => ({
  useGuiHarnessModelsQuery: () => ({ data: undefined }),
}));

afterEach(() => {
  cleanup();
  toastSuccess.mockClear();
});

function candidate(modelFamily: string): TierCandidate {
  return { harnessId: "claude", modelFamily, reasoningEffort: null };
}

function tierGroup(
  id: string,
  candidates: readonly TierCandidate[],
): TierGroup {
  return { id, candidates: [...candidates] };
}

const NO_EFFORT_OPTIONS: FallbackEffortOptions = () => [];

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
      effortOptions={NO_EFFORT_OPTIONS}
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

    const familyInputs = (): HTMLInputElement[] =>
      screen.getAllByLabelText<HTMLInputElement>("Model family");
    expect(familyInputs().map((input) => input.value)).toEqual([
      "opus",
      "sonnet",
    ]);
    const secondRowInput = familyInputs()[1];

    // Move the second row ("sonnet") up one place.
    fireEvent.click(screen.getAllByLabelText("Move up")[1]);

    const reordered = familyInputs();
    expect(reordered.map((input) => input.value)).toEqual(["sonnet", "opus"]);

    // The identity model's whole point: under `key={candidate.key}` React
    // MOVES the existing node to its new position, so the object captured
    // above IS the first input now - not merely an input with the same
    // value. Under an index key React would instead keep the node parked at
    // position 1 and swap only its value, and this assertion would see the
    // value change with the ELEMENT staying the same object at the OLD
    // index - i.e. `reordered[1]` would be `secondRowInput`, not
    // `reordered[0]`.
    expect(reordered[0]).toBe(secondRowInput);
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
      screen.getAllByLabelText<HTMLInputElement>("Group name");
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
    const input = screen.getByLabelText<HTMLInputElement>("Group name");
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
      name: "Delete group",
    });
    const survivor = deleteButtons[1];
    fireEvent.click(deleteButtons[0]);
    // Falsification: pass `[]` instead of `groupDeleteSelectors(groups, index)`
    // into `focusAfterRemoval` at the `onDelete` call site
    // (`fallback-tier-groups-editor.tsx`) - focus would then fall through to
    // "Add a group" (or `document.body`) instead of the surviving neighbour.
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
      name: "Delete group",
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
      name: "Delete group",
    });
    const previousSurvivor = deleteButtons[1];
    fireEvent.click(deleteButtons[2]);
    expect(document.activeElement).toBe(previousSurvivor);
  });

  it("deleting the only remaining group focuses 'Add a group'", () => {
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
    fireEvent.click(screen.getByRole("button", { name: "Delete group" }));
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Add a group" }),
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

  it("removing the only remaining candidate focuses 'Add a model'", () => {
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
      screen.getByRole("button", { name: "Add a model" }),
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
    fireEvent.click(screen.getAllByRole("button", { name: "Delete group" })[0]);
    // Delete "g3" (now the last remaining, originally index 2) second.
    fireEvent.click(
      screen.getAllByRole("button", { name: "Delete group" })[
        screen.getAllByRole("button", { name: "Delete group" }).length - 1
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
        effortOptions={NO_EFFORT_OPTIONS}
        previewPending={false}
        previewUnavailable={false}
        onRetryPreview={() => {}}
        onChange={() => {}}
        onCommit={() => {}}
        onUndo={() => {}}
        onRestoreDefaults={() => {}}
        restorePending={false}
        status={null}
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
