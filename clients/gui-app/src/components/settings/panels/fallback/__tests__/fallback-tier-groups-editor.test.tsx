import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState, type ReactNode } from "react";
import { afterEach, describe, expect, it } from "vitest";
import {
  createDefaultFallbackPolicy,
  type FallbackPolicy,
  type TierCandidate,
  type TierGroup,
} from "@traycer/protocol/host/fallback-policy";
import {
  toKeyedGroups,
  type KeyedGroup,
} from "@/components/settings/panels/fallback/fallback-tier-group-keys";
import { FallbackTierGroupsEditor } from "@/components/settings/panels/fallback/fallback-tier-groups-editor";

afterEach(() => {
  cleanup();
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

/**
 * A minimal stateful wrapper - the editor is fully controlled
 * (`onChange(policy, groups)`), so a DOM test needs something to feed the
 * new `groups` back in. It passes back exactly what the editor handed it,
 * never a re-derivation from the returned policy: re-deriving would run every
 * row back through `toKeyedGroups` and mint fresh identities, which would
 * make this test pass or fail for the wrong reason regardless of what the
 * editor itself does with identity.
 */
function Harness(props: {
  readonly initialPolicy: FallbackPolicy;
  readonly initialGroups: readonly KeyedGroup[];
}): ReactNode {
  const [policy, setPolicy] = useState(props.initialPolicy);
  const [groups, setGroups] = useState(props.initialGroups);
  // Both callbacks feed the SAME state: the move this test drives commits
  // through `onCommit` (every control but a text field commits immediately),
  // so a harness that only wired `onChange` would never see the reorder.
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
      previewPending={false}
      onChange={adopt}
      onCommit={adopt}
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
