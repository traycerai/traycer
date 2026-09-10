import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
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

  it("AX7: the drag handle is hidden from assistive technology and out of the tab order, for EVERY row - not just `notify`", () => {
    // R4/AX7 rewrite. The handle used to be exposed to AT for movable rows and
    // only withheld from `notify` (the "Reorder <label>" label this cell used
    // to assert). That is gone now: dnd-kit's default handle attributes
    // promise a space-bar-and-arrows keyboard gesture this editor does not
    // implement (no `KeyboardSensor` is registered - the ▲▼ buttons are the
    // keyboard/touch path), so `{...attributes}` is never spread on ANY row,
    // and the handle span is `aria-hidden` with no accessible name at all.
    //
    // Falsification: re-add `{...attributes}` to the handle span in
    // `fallback-ladder-editor.tsx` - the queries below would then resolve
    // dnd-kit's default handle affordances again.
    renderLadder(vi.fn(), vi.fn());
    expect(
      screen.queryByLabelText(`Reorder ${FALLBACK_RUNG_COPY.notify.label}`),
    ).toBeNull();
    expect(
      screen.queryByLabelText(`Reorder ${FALLBACK_RUNG_COPY.profile.label}`),
    ).toBeNull();
    expect(screen.queryByRole("button", { name: /Reorder/ })).toBeNull();
    // dnd-kit's default handle attributes are `role="button"`,
    // `tabIndex={0}` and `aria-roledescription="sortable"` - none of them are
    // spread, so no element in any row carries them. Scoped to the "profile"
    // row (the first `listitem`, per DISPLAY_ORDER) rather than the whole
    // document: a document-wide query can redden on an unrelated element
    // (any other Radix primitive setting an explicit tabindex) and says
    // nothing about the HANDLE specifically.
    const profileRow = screen.getAllByRole("listitem")[0];
    expect(
      within(profileRow).queryByRole("button", { name: /Reorder/ }),
    ).toBeNull();
    expect(
      profileRow.querySelector('[aria-roledescription="sortable"]'),
    ).toBeNull();
    expect(profileRow.querySelector('[tabindex="0"]')).toBeNull();

    // The replacement affordance: every movable row exposes "Move <label> up"
    // / "Move <label> down" buttons (pinned individually elsewhere in this
    // file), and the list itself is named and describes how to reorder it for
    // a reader who cannot see the hidden handle.
    //
    // jest-dom matchers (`toHaveAccessibleName`/`toHaveAccessibleDescription`)
    // are not wired into this repo's vitest setup (see the sibling comments in
    // `host-switcher-surface-refusal.test.tsx` and `pr-detail-files-tab.test.tsx`),
    // so the name/description are resolved by hand through `aria-labelledby` /
    // `aria-describedby` rather than asserted with those matchers.
    const list = screen.getByRole("list");
    const labelledBy = list.getAttribute("aria-labelledby");
    const label =
      labelledBy === null ? null : document.getElementById(labelledBy);
    expect(label?.textContent).toBe("Try these in order");
    const describedBy = list.getAttribute("aria-describedby");
    const description =
      describedBy === null ? null : document.getElementById(describedBy);
    expect(description?.textContent ?? "").toContain(
      "Move up and Move down buttons",
    );
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
    // R5 RE-SPECIFIED the second of these. It used to read:
    //
    //     expect(profileUp.disabled).toBe(true);
    //     expect(profileDown.disabled).toBe(false);
    //
    // on the reasoning that "profile" is the first movable row, so only its
    // "up" has nowhere to go. That was the behaviour R5 removed: this
    // fixture's `notify` sits at displayOrder index 1, so the fixed slot is
    // immediately BELOW "profile", and moving it down carried an enabled step
    // past the terminal one - a row that reads as running and never can.
    // Both of its arrows are therefore disabled here, for two different
    // reasons: nothing above it, and the boundary immediately below it.
    expect(profileUp.disabled).toBe(true);
    expect(profileDown.disabled).toBe(true);
    // ...and the control needs a row whose arrow is genuinely LIVE, or
    // "the buttons exist" is satisfied by two permanently greyed-out ones and
    // proves much less than it looks like it does. "wait" is the last movable
    // row and sits below the slot, so its "up" moves within the far side and
    // is enabled.
    expect(
      screen.getByLabelText<HTMLButtonElement>(
        `Move ${FALLBACK_RUNG_COPY.wait.label} up`,
      ).disabled,
    ).toBe(false);
  });

  it("clicking a movable row's down arrow calls onMove with indices among the MOVABLE steps, not into displayOrder", () => {
    const { onMove } = renderLadder(vi.fn(), vi.fn());
    // R5 RE-SPECIFIED which row this drives. It used to click "profile" down
    // and assert:
    //
    //     expect(onMove).toHaveBeenCalledWith(0, 1);
    //
    // That move straddles the fixed slot, so its arrow is now disabled and the
    // click reaches nothing - the test would pass only by proving the button
    // is dead. The PROPOSITION is unchanged and is not about "profile": the
    // indices handed to `onMove` are positions among the MOVABLE steps, not
    // into `displayOrder`. "tier" is movable index 1 but displayOrder index 2,
    // and "wait" is movable 2 but displayOrder 3, so a caller passing display
    // indices would report (2, 3) here and this still separates them.
    fireEvent.click(
      screen.getByLabelText(`Move ${FALLBACK_RUNG_COPY.tier.label} down`),
    );
    expect(onMove).toHaveBeenCalledWith(1, 2);
  });

  it("R5: the arrow that would carry a movable row across an early `notify` is disabled on BOTH sides of the slot", () => {
    // The pair the two cases above only half-cover, and the reason this file
    // needed its own R5 case rather than an edited assertion: the boundary is
    // a two-sided rule. Reaching it from below is refused as firmly as
    // reaching it from above, and neither is the ordinary "you are at the end
    // of the list" disable that a ladder with `notify` last would produce.
    renderLadder(vi.fn(), vi.fn());
    // Above the slot, moving down: refused (and "profile" is not last).
    expect(
      screen.getByLabelText<HTMLButtonElement>(
        `Move ${FALLBACK_RUNG_COPY.profile.label} down`,
      ).disabled,
    ).toBe(true);
    // Below the slot, moving up: refused (and "tier" is not first).
    expect(
      screen.getByLabelText<HTMLButtonElement>(
        `Move ${FALLBACK_RUNG_COPY.tier.label} up`,
      ).disabled,
    ).toBe(true);
    // Falsification: drop `|| movableIndex === movableBoundary` from the up
    // arrow and `|| movableIndex === movableBoundary - 1` from the down arrow
    // in `fallback-ladder-editor.tsx`. Both arrows go live, and
    // `moveFallbackRung` then refuses the move SILENTLY - a control that
    // responds to a click by doing nothing and saying nothing.
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
