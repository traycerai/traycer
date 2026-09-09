import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FallbackRungKind } from "@traycer/protocol/host/fallback-policy";
import { FallbackLadderEditor } from "@/components/settings/panels/fallback/fallback-ladder-editor";
import { FALLBACK_RUNG_COPY } from "@/components/settings/panels/fallback/fallback-rung-copy";

afterEach(() => {
  cleanup();
});

/**
 * `notify` deliberately sits in the MIDDLE of this fixture, not at the end -
 * the same non-canonical case `moveFallbackRung` is tested against, and the
 * one every arrow/handle assertion here has to hold under.
 */
const DISPLAY_ORDER: readonly FallbackRungKind[] = [
  "profile",
  "notify",
  "tier",
  "wait",
];
const ALL_ENABLED = new Set<FallbackRungKind>([
  "profile",
  "notify",
  "tier",
  "wait",
]);

function renderLadder(
  onMove: (fromIndex: number, toIndex: number) => void,
  onToggle: (rung: FallbackRungKind, next: boolean) => void,
) {
  render(
    <FallbackLadderEditor
      displayOrder={DISPLAY_ORDER}
      enabled={ALL_ENABLED}
      onToggle={onToggle}
      onMove={onMove}
      profileStepHint={null}
    />,
  );
  return { onMove, onToggle };
}

describe("FallbackLadderEditor", () => {
  it("renders `notify` at its stored position rather than forcing it to the end", () => {
    renderLadder(vi.fn(), vi.fn());
    const rows = screen.getAllByRole("listitem");
    // `textContent`'s getter type is `string` (TS's DOM lib splits the
    // getter/setter types, and the setter alone accepts `null`), so a `?? ""`
    // fallback here is a dead branch rather than a real guard.
    const labels = rows.map((row) => row.textContent);
    // "notify" (label "Notify me") comes second, matching DISPLAY_ORDER -
    // exactly the honest-rendering behaviour the module comment describes.
    expect(labels[1]).toContain(FALLBACK_RUNG_COPY.notify.label);
  });

  it("gives `notify` no drag handle - the reserved gutter renders instead", () => {
    renderLadder(vi.fn(), vi.fn());
    // Every movable row exposes "Reorder <label>"; `notify` never has this
    // element at all (not merely a disabled one), because it renders the
    // reserved empty gutter span in its place.
    expect(
      screen.queryByLabelText(`Reorder ${FALLBACK_RUNG_COPY.notify.label}`),
    ).toBeNull();
    // Positive control: a movable row DOES have one, proving the query above
    // would find a handle if the fixed row rendered one too.
    expect(
      screen.getByLabelText(`Reorder ${FALLBACK_RUNG_COPY.profile.label}`),
    ).not.toBeNull();
  });

  it("renders no up/down controls at all for `notify` - absent, not merely disabled", () => {
    renderLadder(vi.fn(), vi.fn());
    // Absence, not a disabled state: a disabled control says "not right now"
    // and invites the reader to look for what would enable it, which is the
    // same distinction the overrides matrix draws between an "off" chip and
    // an "impossible" one.
    expect(
      screen.queryByLabelText(`Move ${FALLBACK_RUNG_COPY.notify.label} up`),
    ).toBeNull();
    expect(
      screen.queryByLabelText(`Move ${FALLBACK_RUNG_COPY.notify.label} down`),
    ).toBeNull();

    // Positive control: render a movable rung through this same path and its
    // reorder buttons DO appear (disabled or not, per its own position) - so
    // the absence above is `notify`'s own and not a query that would find
    // nothing for any row.
    const profileUp = screen.getByLabelText<HTMLButtonElement>(
      `Move ${FALLBACK_RUNG_COPY.profile.label} up`,
    );
    const profileDown = screen.getByLabelText<HTMLButtonElement>(
      `Move ${FALLBACK_RUNG_COPY.profile.label} down`,
    );
    // "profile" is the first MOVABLE row (movable index 0) in this fixture,
    // so its "up" is disabled (nothing above it among movable steps) but its
    // "down" is not.
    expect(profileUp.disabled).toBe(true);
    expect(profileDown.disabled).toBe(false);
  });

  it("clicking a movable row's down arrow calls onMove with indices among the MOVABLE steps, not into displayOrder", () => {
    const { onMove } = renderLadder(vi.fn(), vi.fn());
    fireEvent.click(
      screen.getByLabelText(`Move ${FALLBACK_RUNG_COPY.profile.label} down`),
    );
    // "profile" is movable index 0 (displayOrder index 0); "tier" is the next
    // MOVABLE step (movable index 1), skipping over the fixed `notify` slot
    // at displayOrder index 1.
    expect(onMove).toHaveBeenCalledWith(0, 1);
  });

  it("toggling a step's switch calls onToggle for that step alone, leaving order to the caller", () => {
    const { onToggle } = renderLadder(vi.fn(), vi.fn());
    fireEvent.click(
      screen.getByLabelText(`${FALLBACK_RUNG_COPY.tier.label} - run this step`),
    );
    expect(onToggle).toHaveBeenCalledWith("tier", false);
    expect(onToggle).toHaveBeenCalledTimes(1);
  });
});

describe("FallbackLadderEditor - F19 notify has no switch", () => {
  it("renders no `switch` role for notify at all, while every movable row DOES have one", () => {
    render(
      <FallbackLadderEditor
        displayOrder={DISPLAY_ORDER}
        enabled={ALL_ENABLED}
        onToggle={vi.fn()}
        onMove={vi.fn()}
        profileStepHint={null}
      />,
    );
    // Falsification: render `<Switch>` for the fixed step too (undo the
    // `fixed ? <FixedStepControl .../> : <Switch .../>` branch in
    // `FallbackLadderRow`, `fallback-ladder-editor.tsx`) - this would then
    // find a switch named "Notify me - run this step".
    expect(
      screen.queryByRole("switch", {
        name: `${FALLBACK_RUNG_COPY.notify.label} - run this step`,
      }),
    ).toBeNull();
    // Positive control: a movable row DOES expose one, proving the query
    // above would find a switch if notify rendered one too.
    expect(
      screen.getByRole("switch", {
        name: `${FALLBACK_RUNG_COPY.profile.label} - run this step`,
      }),
    ).not.toBeNull();
  });

  it("with notify absent from `enabled`, the 'add this step back' link appears and calls onToggle(\"notify\", true)", () => {
    const onToggle = vi.fn();
    const enabled = new Set<FallbackRungKind>(["profile", "tier", "wait"]);
    render(
      <FallbackLadderEditor
        displayOrder={DISPLAY_ORDER}
        enabled={enabled}
        onToggle={onToggle}
        onMove={vi.fn()}
        profileStepHint={null}
      />,
    );
    const addBack = screen.getByRole("button", {
      name: `${FALLBACK_RUNG_COPY.notify.label} - add this step back`,
    });
    // Falsification: swap the `enabled` branch in `FixedStepControl`
    // (`fallback-ladder-editor.tsx`) so it always renders the "Always" span -
    // this button would then not exist at all.
    fireEvent.click(addBack);
    expect(onToggle).toHaveBeenCalledWith("notify", true);
    // And the "Always" static label is absent while notify is off.
    expect(screen.queryByTestId("fallback-step-always-on")).toBeNull();
  });

  it("with notify present in `enabled`, 'Always' renders and the 'add this step back' link is absent", () => {
    render(
      <FallbackLadderEditor
        displayOrder={DISPLAY_ORDER}
        enabled={ALL_ENABLED}
        onToggle={vi.fn()}
        onMove={vi.fn()}
        profileStepHint={null}
      />,
    );
    expect(screen.getByTestId("fallback-step-always-on")).not.toBeNull();
    expect(
      screen.queryByRole("button", {
        name: `${FALLBACK_RUNG_COPY.notify.label} - add this step back`,
      }),
    ).toBeNull();
  });
});
