import "../../../../__tests__/test-browser-apis";
import { cleanup, render, screen, act } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { StreamConnectionStatus } from "@traycer-clients/shared/host-transport/i-stream-session";
import { StreamSyncingBar } from "@/components/sync/stream-syncing-bar";
import { LINK_DOWN_ESCALATION_MS } from "@/lib/link-down-escalation";

const TEST_ID = "syncing-bar";

function renderBar(input: {
  readonly status: StreamConnectionStatus;
  readonly hasContent: boolean;
}) {
  return render(
    <StreamSyncingBar
      status={input.status}
      hasContent={input.hasContent}
      surfaceLabel="Task"
      testId={TEST_ID}
    />,
  );
}

/**
 * The strip's whole rendered text. Read as a string rather than queried per
 * node because the visible word and the screen-reader-only surface name share
 * one line, and the escalation assertions turn on which of the two words is
 * present - "Task: Still syncing…" does not contain "Syncing…", so the same
 * `toContain` distinguishes them without a second matcher.
 */
function barText(): string {
  return screen.getByTestId(TEST_ID).textContent;
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("<StreamSyncingBar />", () => {
  // The gate, as a matrix rather than as a handful of examples: the whole
  // contract is "a surface with content on screen whose own stream is away",
  // and every other combination has to stay silent - including the two that
  // look like they should speak (a cold connect, a dead stream).
  const STATUSES: readonly StreamConnectionStatus[] = [
    "connecting",
    "open",
    "reconnecting",
    "closed",
  ];
  const SHOWS_BAR: ReadonlySet<StreamConnectionStatus> = new Set([
    "connecting",
    "reconnecting",
  ]);

  for (const status of STATUSES) {
    for (const hasContent of [true, false]) {
      const expected = hasContent && SHOWS_BAR.has(status);
      it(`${expected ? "shows" : "hides"} the bar for status=${status} hasContent=${String(hasContent)}`, () => {
        renderBar({ status, hasContent });
        expect(screen.queryByTestId(TEST_ID) === null).toBe(!expected);
      });
    }
  }

  it("says Syncing… and nothing stronger while the resync is young", () => {
    renderBar({ status: "reconnecting", hasContent: true });
    expect(barText()).toContain("Syncing…");
    expect(barText()).not.toContain("Still syncing…");
    expect(screen.getByTestId(TEST_ID).dataset.syncState).toBe("syncing");
  });

  it("names the surface for a screen reader without showing the name", () => {
    renderBar({ status: "reconnecting", hasContent: true });
    // The visible word is the short one; the surface name is what a reader
    // hearing the strip out of context needs, so it is present but unseen.
    expect(barText()).toContain("Task");
    expect(screen.getByRole("status").getAttribute("aria-busy")).toBe("true");
  });

  it("escalates to Still syncing… once the resync stops looking momentary", () => {
    vi.useFakeTimers();
    renderBar({ status: "reconnecting", hasContent: true });
    expect(barText()).toContain("Syncing…");

    act(() => {
      vi.advanceTimersByTime(LINK_DOWN_ESCALATION_MS - 1);
    });
    expect(barText()).not.toContain("Still syncing…");

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(barText()).toContain("Still syncing…");
    expect(screen.getByTestId(TEST_ID).dataset.syncState).toBe("stalled");
  });

  it("stops the travel at escalation instead of animating without end", () => {
    // The animation is bounded by the escalation, not only by the reader's
    // motion preference: a resync that never converges would otherwise keep a
    // CSS animation running for as long as the app is in the foreground, and
    // this stylesheet has already measured what one always-on indicator costs.
    vi.useFakeTimers();
    renderBar({ status: "reconnecting", hasContent: true });
    const sweep = screen.getByTestId(`${TEST_ID}-sweep`);
    expect(sweep.classList.contains("stream-syncing-sweep")).toBe(true);

    act(() => {
      vi.advanceTimersByTime(LINK_DOWN_ESCALATION_MS);
    });
    const settled = screen.getByTestId(`${TEST_ID}-sweep`);
    expect(settled.classList.contains("stream-syncing-sweep")).toBe(false);
    // Still visible, and now spanning the track - presence rather than travel,
    // the same still form reduced motion produces.
    expect(settled.classList.contains("w-full")).toBe(true);
    expect(settled.classList.contains("w-2/5")).toBe(false);
  });

  it("does not restart the escalation clock when connecting flips to reconnecting", () => {
    // One outage seen twice. A clock keyed on the STATUS rather than on the
    // spell would reset here and never escalate on a link that flaps.
    vi.useFakeTimers();
    const view = renderBar({ status: "connecting", hasContent: true });
    act(() => {
      vi.advanceTimersByTime(LINK_DOWN_ESCALATION_MS / 2);
    });
    view.rerender(
      <StreamSyncingBar
        status="reconnecting"
        hasContent
        surfaceLabel="Task"
        testId={TEST_ID}
      />,
    );
    act(() => {
      vi.advanceTimersByTime(LINK_DOWN_ESCALATION_MS / 2);
    });
    expect(barText()).toContain("Still syncing…");
  });

  it("drops the escalated word the moment the stream is back", () => {
    vi.useFakeTimers();
    const view = renderBar({ status: "reconnecting", hasContent: true });
    act(() => {
      vi.advanceTimersByTime(LINK_DOWN_ESCALATION_MS);
    });
    expect(barText()).toContain("Still syncing…");

    view.rerender(
      <StreamSyncingBar
        status="open"
        hasContent
        surfaceLabel="Task"
        testId={TEST_ID}
      />,
    );
    expect(screen.queryByTestId(TEST_ID)).toBeNull();

    // And a LATER, genuinely new outage starts unescalated rather than
    // inheriting the previous one's verdict.
    view.rerender(
      <StreamSyncingBar
        status="reconnecting"
        hasContent
        surfaceLabel="Task"
        testId={TEST_ID}
      />,
    );
    expect(barText()).toContain("Syncing…");
    expect(barText()).not.toContain("Still syncing…");
  });

  it("carries the motion on a class, so reduced motion can reach it", () => {
    // An inline `animation` style cannot be overridden by the reduced-motion
    // rule that ships beside it - which is exactly why the two host-install
    // bars do not honour reduced motion. Pin the class, and pin the absence
    // of the inline style that would silently defeat it.
    renderBar({ status: "reconnecting", hasContent: true });
    const sweep = screen.getByTestId(`${TEST_ID}-sweep`);
    expect(sweep.classList.contains("stream-syncing-sweep")).toBe(true);
    expect(sweep.style.animation).toBe("");
  });

  it("keeps the track off `bg-muted`, which collapses on raised surfaces", () => {
    renderBar({ status: "reconnecting", hasContent: true });
    const track = screen.getByTestId(`${TEST_ID}-sweep`).parentElement;
    expect(track?.classList.contains("bg-muted")).toBe(false);
    expect(track?.classList.contains("bg-foreground/8")).toBe(true);
  });
});
