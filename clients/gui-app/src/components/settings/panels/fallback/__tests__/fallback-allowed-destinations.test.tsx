import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createDefaultFallbackPolicy,
  fallbackPolicySchema,
  type FallbackPolicy,
  type TierCandidate,
  type TierGroup,
} from "@traycer/protocol/host/fallback-policy";
import { FallbackAllowedDestinations } from "@/components/settings/panels/fallback/fallback-allowed-destinations";
import {
  toKeyedGroups,
  withTierGroups,
} from "@/components/settings/panels/fallback/fallback-tier-group-keys";
import {
  createFallbackPolicyDraftState,
  fallbackPolicyValuesEqual,
} from "@/components/settings/panels/fallback/fallback-policy-draft";

afterEach(() => {
  cleanup();
});

function candidate(
  harnessId: TierCandidate["harnessId"],
  modelFamily: string,
): TierCandidate {
  return { harnessId, modelFamily, reasoningEffort: null };
}

function group(id: string, candidates: readonly TierCandidate[]): TierGroup {
  return { id, candidates: [...candidates] };
}

function policy(overrides: Partial<FallbackPolicy>): FallbackPolicy {
  return { ...createDefaultFallbackPolicy(), ...overrides };
}

function renderDestinations(
  value: FallbackPolicy,
  onChange: (next: FallbackPolicy) => void,
): void {
  render(
    <FallbackAllowedDestinations
      policy={value}
      onChange={onChange}
      status={null}
    />,
  );
}

describe("FallbackAllowedDestinations", () => {
  it("has an accessible group and summarizes unique model-group members minus exclusions", () => {
    const value = policy({
      tierGroups: [
        group("first", [
          candidate("claude", "sonnet"),
          candidate("codex", "gpt"),
        ]),
        group("second", [candidate("claude", "haiku")]),
      ],
      destinationExclusions: ["codex"],
    });

    renderDestinations(value, vi.fn());

    const section = screen.getByRole("group", { name: "Allowed destinations" });
    expect(section).toBeDefined();
    expect(screen.getByText("Can switch to: Claude Code")).toBeDefined();
    expect(screen.queryByText(/Can switch to:.*Codex/)).toBeNull();
    // A switch per provider, ON meaning "may be switched to" - so the allowed
    // provider reads as on, rather than as an unchecked box beside "Never".
    expect(
      screen.getByRole("switch", { name: "Allow switching to Claude Code" })
        .dataset.state,
    ).toBe("checked");
    expect(
      screen.getByRole("switch", { name: "Allow switching to Codex" }).dataset
        .state,
    ).toBe("unchecked");
  });

  it("writes an exclusion while retaining every other policy field and the source group", () => {
    const value = policy({
      enabled: true,
      destinationExclusions: ["codex"],
      tierGroups: [group("sources", [candidate("claude", "sonnet")])],
      ladder: ["tier", "notify"],
      graceWindowSeconds: 25,
      maxWaitMinutes: 42,
      returnToPreferred: "stay",
    });
    const onChange = vi.fn<(next: FallbackPolicy) => void>();
    renderDestinations(value, onChange);

    // Turning Claude OFF is what excludes it.
    fireEvent.click(
      screen.getByRole("switch", { name: "Allow switching to Claude Code" }),
    );

    const changed = onChange.mock.calls.at(0)?.[0];
    expect(changed?.destinationExclusions).toEqual(["codex", "claude"]);
    expect(changed?.tierGroups).toBe(value.tierGroups);
    expect(changed?.enabled).toBe(value.enabled);
    expect(changed?.ladder).toEqual(value.ladder);
    expect(changed?.graceWindowSeconds).toBe(value.graceWindowSeconds);
    expect(changed?.maxWaitMinutes).toBe(value.maxWaitMinutes);
    expect(changed?.returnToPreferred).toBe(value.returnToPreferred);
  });

  it("clears an exclusion without deleting the provider's valid source row", () => {
    const value = policy({
      destinationExclusions: ["claude", "codex"],
      tierGroups: [group("sources", [candidate("claude", "sonnet")])],
    });
    const onChange = vi.fn<(next: FallbackPolicy) => void>();
    renderDestinations(value, onChange);

    // Claude is excluded, so its switch is off; turning it ON clears that.
    fireEvent.click(
      screen.getByRole("switch", { name: "Allow switching to Claude Code" }),
    );

    const changed = onChange.mock.calls.at(0)?.[0];
    expect(changed?.destinationExclusions).toEqual(["codex"]);
    expect(changed?.tierGroups).toBe(value.tierGroups);

    cleanup();
    if (changed === undefined) throw new Error("Expected an exclusion update");
    renderDestinations(changed, onChange);
    expect(screen.getByText("Can switch to: Claude Code")).toBeDefined();
  });

  it("keeps an excluded provider's control after its last membership row is removed", () => {
    const value = policy({
      destinationExclusions: ["codex"],
      tierGroups: [],
    });
    const onChange = vi.fn<(next: FallbackPolicy) => void>();
    renderDestinations(value, onChange);

    expect(screen.getByText("Can switch to: none")).toBeDefined();
    const toggle = screen.getByRole("switch", {
      name: "Allow switching to Codex",
    });
    // Excluded reads as OFF now, where the old "Never switch to" box read as
    // checked for the same state.
    expect(toggle.getAttribute("data-state")).toBe("unchecked");

    fireEvent.click(toggle);
    const changed = onChange.mock.calls.at(0)?.[0];
    expect(changed?.destinationExclusions).toEqual([]);
    expect(changed?.tierGroups).toEqual([]);
  });
});

describe("fallback destination policy protocol and draft round trips", () => {
  it("legacy policy input without destinationExclusions parses as an empty list", () => {
    const { destinationExclusions: omitted, ...legacy } =
      createDefaultFallbackPolicy();
    expect(omitted).toEqual([]);
    const parsed = fallbackPolicySchema.parse(legacy);
    expect(parsed.destinationExclusions).toEqual([]);
  });

  it("rejects a destination exclusion that is not a known harness id", () => {
    const parsed = fallbackPolicySchema.safeParse({
      ...createDefaultFallbackPolicy(),
      destinationExclusions: ["not-a-harness"],
    });
    expect(parsed.success).toBe(false);
  });

  it("round-trips the full policy through keyed groups and the draft state", () => {
    const value = policy({
      destinationExclusions: ["codex"],
      tierGroups: [group("sources", [candidate("codex", "gpt")])],
    });
    const keyed = toKeyedGroups(value.tierGroups);
    const projected = withTierGroups(value, keyed);
    const draft = createFallbackPolicyDraftState(projected);

    expect(projected).toEqual(value);
    expect(draft.persisted).toEqual(value);
    expect(draft.draft).toEqual(value);
    expect(fallbackPolicyValuesEqual(projected, value)).toBe(true);
    expect(
      fallbackPolicyValuesEqual(value, { ...value, destinationExclusions: [] }),
    ).toBe(false);
  });

  it("creates fresh exclusion and tier-group arrays for every default policy", () => {
    const first = createDefaultFallbackPolicy();
    const second = createDefaultFallbackPolicy();
    expect(first.destinationExclusions).not.toBe(second.destinationExclusions);
    expect(first.tierGroups).not.toBe(second.tierGroups);
  });
});
