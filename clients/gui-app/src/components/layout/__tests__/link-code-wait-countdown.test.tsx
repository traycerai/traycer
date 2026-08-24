/**
 * The approval wait's countdown across a CHANGE OF TARGET.
 *
 * The poll loop republishes `nextPollAtMs` after every poll, on the server's
 * cadence, while this component stays mounted. `useRemainingSeconds` samples
 * the clock when it mounts and then only on its own one-second tick, so a new
 * target arriving between ticks would be subtracted from an outdated instant
 * and could render one second more than the service advertised. The wait line
 * is keyed on the target so each one gets a freshly sampled clock; this is
 * what holds that key in place.
 */
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LinkLoginProgress } from "@/lib/auth/auth-service";

const progressHolder: { current: LinkLoginProgress | null } = { current: null };

vi.mock("@/lib/host", () => ({
  useAuthService: () => ({}),
}));

vi.mock("@/hooks/auth/use-auth-link-login-progress", () => ({
  useAuthLinkLoginProgress: () => progressHolder.current,
}));

import { LinkCodeWaitStatus } from "@/components/layout/header/sign-in/link-code-wait-status";

const START_MS = 1_760_000_000_000;

function statusText(): string | null {
  return screen.getByTestId("link-code-signin-poll-status").textContent;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(START_MS);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  progressHolder.current = null;
});

describe("link-login approval countdown", () => {
  it("counts a new poll target from the clock now, not from the last tick", () => {
    progressHolder.current = {
      nextPollAtMs: START_MS + 3_000,
      phase: "waiting",
    };
    const view = render(<LinkCodeWaitStatus />);
    expect(statusText()).toBe("Checking again in 3s");

    // Mid-tick: under a second of interval has elapsed, so nothing has
    // resampled the clock when the next 3-second target is published. The
    // component stays MOUNTED across this — that is the whole scenario.
    act(() => {
      vi.advanceTimersByTime(800);
    });
    progressHolder.current = {
      nextPollAtMs: START_MS + 800 + 3_000,
      phase: "waiting",
    };
    view.rerender(<LinkCodeWaitStatus />);

    // 3s, as advertised. Subtracting from the mount-time sample gives 4s.
    expect(statusText()).toBe("Checking again in 3s");
  });

  it("reads the checking beat once the target has passed", () => {
    progressHolder.current = {
      nextPollAtMs: START_MS + 1_000,
      phase: "waiting",
    };
    render(<LinkCodeWaitStatus />);
    act(() => {
      vi.advanceTimersByTime(1_100);
    });

    // The poll is due, so a visibly stopped "0s" would be a clock the user can
    // see has stalled.
    expect(statusText()).toContain("Checking…");
  });
});
