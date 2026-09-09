import "../../../../__tests__/test-browser-apis";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StreamSyncingBar } from "@/components/sync/stream-syncing-bar";
import type { StreamSyncingSpell } from "@/lib/sync/stream-syncing-state";

const TEST_ID = "syncing-bar";

const wake = vi.fn();

function renderBar(spell: StreamSyncingSpell) {
  return render(
    <StreamSyncingBar
      spell={spell}
      onWake={wake}
      surfaceLabel="Task"
      testId={TEST_ID}
    />,
  );
}

/**
 * The strip's whole rendered text. Read as a string rather than queried per
 * node because the visible word and the screen-reader-only surface name share
 * one line, and the assertions turn on which of the two words is present -
 * "Task: Still syncing…" does not contain "Syncing…", so the same `toContain`
 * distinguishes them without a second matcher.
 */
function barText(): string {
  return screen.getByTestId(TEST_ID).textContent;
}

function sweep(): HTMLElement {
  return screen.getByTestId(`${TEST_ID}-sweep`);
}

afterEach(() => {
  cleanup();
  wake.mockClear();
});

describe("<StreamSyncingBar />", () => {
  it("renders nothing when no spell is running", () => {
    renderBar({ syncing: false, escalated: false });
    expect(screen.queryByTestId(TEST_ID)).toBeNull();
  });

  it("spends no words at all while the resync is young", () => {
    // What this reports usually lasts two to four seconds, and a word that
    // appears and vanishes in that time reads as an alarm rather than as
    // information - the same rule the app-wide session strip follows.
    renderBar({ syncing: true, escalated: false });
    expect(screen.queryByTestId(`${TEST_ID}-text`)).toBeNull();
    expect(screen.getByTestId(TEST_ID).dataset.syncState).toBe("syncing");
  });

  it("shows Still syncing… once the spell has escalated", () => {
    renderBar({ syncing: true, escalated: true });
    expect(screen.getByTestId(`${TEST_ID}-text`).textContent).toBe(
      "Still syncing…",
    );
    expect(screen.getByTestId(TEST_ID).dataset.syncState).toBe("stalled");
  });

  it("keeps the whole sentence audible in BOTH states, shown or not", () => {
    // What a screen reader hears must not depend on which visual form is up.
    // The ordinary state shows nothing and still announces it.
    renderBar({ syncing: true, escalated: false });
    expect(barText()).toContain("Task");
    expect(barText()).toContain("Syncing…");
    cleanup();
    renderBar({ syncing: true, escalated: true });
    expect(barText()).toContain("Task");
    expect(barText()).toContain("Still syncing…");
  });

  it("announces politely and is NOT marked busy", () => {
    // `aria-busy` on this node would ask a reader to hold its updates until it
    // clears - and it never clears, the strip is removed instead - so the one
    // update worth hearing (the escalation) could sit undelivered for the whole
    // outage. It would not describe the stale content beside the strip either.
    renderBar({ syncing: true, escalated: false });
    const region = screen.getByRole("status");
    expect(region.hasAttribute("aria-busy")).toBe(false);
  });

  it("travels while the resync is young", () => {
    // An inline `animation` style cannot be overridden by the reduced-motion
    // rule that ships beside it - which is exactly why the two host-install
    // bars do not honour reduced motion. Pin the class, and pin the absence of
    // the inline style that would silently defeat it.
    renderBar({ syncing: true, escalated: false });
    expect(sweep().classList.contains("stream-syncing-sweep")).toBe(true);
    expect(sweep().classList.contains("w-2/5")).toBe(true);
    expect(sweep().style.animation).toBe("");
  });

  it("stops the travel at escalation instead of animating without end", () => {
    // Bounded by the escalation, not only by the reader's motion preference: a
    // resync that never converges would otherwise keep a CSS animation running
    // for as long as the app is in the foreground, and this stylesheet has
    // already measured what one always-on indicator costs.
    renderBar({ syncing: true, escalated: true });
    expect(sweep().classList.contains("stream-syncing-sweep")).toBe(false);
    // Still visible, and now spanning the track - presence rather than travel,
    // the same still form reduced motion produces.
    expect(sweep().classList.contains("w-full")).toBe(true);
    expect(sweep().classList.contains("w-2/5")).toBe(false);
  });

  it("offers no Retry while the transport is still on its first attempt", () => {
    // The transport is already redialing and has not yet failed, so a button
    // here would invite a tap that changes nothing.
    renderBar({ syncing: true, escalated: false });
    expect(screen.queryByTestId(`${TEST_ID}-retry`)).toBeNull();
  });

  it("offers Retry once escalated, and wakes only when pressed", async () => {
    renderBar({ syncing: true, escalated: true });
    expect(wake).not.toHaveBeenCalled();
    await userEvent.click(screen.getByTestId(`${TEST_ID}-retry`));
    expect(wake).toHaveBeenCalledTimes(1);
  });

  it("shows no Retry when the surface has no session to wake", () => {
    render(
      <StreamSyncingBar
        spell={{ syncing: true, escalated: true }}
        onWake={null}
        surfaceLabel="Task"
        testId={TEST_ID}
      />,
    );
    expect(screen.getByTestId(`${TEST_ID}-text`)).toBeTruthy();
    expect(screen.queryByTestId(`${TEST_ID}-retry`)).toBeNull();
  });

  it("keeps the track off `bg-muted`, which collapses on raised surfaces", () => {
    renderBar({ syncing: true, escalated: false });
    const track = sweep().parentElement;
    expect(track?.classList.contains("bg-muted")).toBe(false);
    expect(track?.classList.contains("bg-foreground/8")).toBe(true);
  });
});
