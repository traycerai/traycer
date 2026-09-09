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
}): ReactNode {
  const [policy, setPolicy] = useState(props.initialPolicy);
  const [groups, setGroups] = useState(props.initialGroups);
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
      previewPending={false}
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
