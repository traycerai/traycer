import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FallbackWaitingCard } from "@/components/chat/fallback/fallback-waiting-card";
import { formatResetDateTime } from "@/lib/relative-time";
import { useSettingsHostScopeStore } from "@/stores/settings/settings-host-scope-store";
import {
  BANNED_VOCABULARY,
  FAILED_CLAUDE_TUPLE,
  pendingFallback,
} from "./fallback-fixtures";

const mocks = vi.hoisted(() => ({
  mutate: vi.fn(),
  openSettings: vi.fn(),
}));

vi.mock("@/hooks/providers/use-providers-list-query", () => ({
  useProvidersListForClient: () => ({ data: undefined }),
}));

vi.mock("@/hooks/host/use-host-scoped-mutation", () => ({
  useHostScopedMutationForClient: () => ({
    mutate: mocks.mutate,
    isPending: false,
  }),
}));

vi.mock("@/stores/tabs/use-system-tab-modal", () => ({
  useSystemTabModalActions: () => ({ openSettings: mocks.openSettings }),
}));

function waitingPending(deadline: number | null) {
  return pendingFallback({
    state: "waiting",
    reason: "rate_limit",
    failedTuple: FAILED_CLAUDE_TUPLE,
    targetTuple: null,
    impendingAction: null,
    deadline,
    attempt: 1,
    maxAttempts: 1,
    queuedItemsMoving: 1,
    siblingSwitching: 0,
    traversalId: "traversal-wait",
    revision: 5,
  });
}

function renderCard(input: { readonly deadline: number | null }) {
  return render(
    <FallbackWaitingCard
      pending={waitingPending(input.deadline)}
      client={null}
      chatId="chat-wait"
      epicId="epic-wait"
      hostId="tab-host-b"
      canAct
      menu={null}
    />,
  );
}

describe("FallbackWaitingCard", () => {
  beforeEach(() => {
    mocks.mutate.mockReset();
    mocks.openSettings.mockReset();
    useSettingsHostScopeStore.getState().setScopedHostId("app-host-a");
  });

  afterEach(() => {
    cleanup();
    useSettingsHostScopeStore.getState().setScopedHostId(null);
    vi.useRealTimers();
  });

  it("CARRIES a 12-hour resume time in a status live region, with the countdown OUTSIDE it (AX9 split)", () => {
    // "Carries", not "announces": this region mounts already holding the
    // deadline, and a live region that arrives with its text announces
    // nothing. Entry is spoken by the chat announcer's `waiting` sentence
    // (`stores/chats/chat-announcements.ts`); what this region contributes is
    // the later CHANGE, pinned by the deadline case below.
    //
    // RE-SPECIFIED for AX9: the region used to carry the whole sentence,
    // including the countdown, which meant every minute tick re-announced it.
    // The region now carries only the fixed deadline clause; the countdown
    // lives in a sibling span that is still in the accessibility tree (the
    // whole card's text still contains it) but is not itself the live region.
    // Falsification: put "(in about ...)" back inside the role="status" span in fallback-waiting-card.tsx and THIS assertion must go red.
    renderCard({
      deadline: Date.now() + 2 * 60 * 60 * 1000,
    });
    const headline = screen.getByRole("status");
    expect(headline.textContent).toMatch(
      /^Resuming at \d{1,2}:\d{2}\s?[AP]M$/i,
    );
    expect(headline.textContent).not.toMatch(/\(in about/);
    expect(screen.getByTestId("fallback-waiting-card").textContent).toMatch(
      /\(in about /,
    );
    expect(screen.getByTestId("fallback-waiting-card").textContent).not.toMatch(
      BANNED_VOCABULARY,
    );
  });

  it("N minute ticks change the visual countdown and never the live region", async () => {
    // Falsification: put "(in about ...)" back inside the role="status" span in fallback-waiting-card.tsx and THIS assertion must go red.
    vi.useFakeTimers();
    const deadline = Date.now() + 2 * 60 * 60 * 1000;
    renderCard({ deadline });
    const status = screen.getByRole("status");
    const entryStatusText = status.textContent;
    const entryCardText = screen.getByTestId(
      "fallback-waiting-card",
    ).textContent;

    const records: MutationRecord[] = [];
    const observer = new MutationObserver((mutations) => {
      records.push(...mutations);
    });
    observer.observe(status, {
      childList: true,
      characterData: true,
      subtree: true,
    });

    await act(async () => {
      vi.advanceTimersByTime(60_000);
      await Promise.resolve();
    });
    await act(async () => {
      vi.advanceTimersByTime(60_000);
      await Promise.resolve();
    });
    await act(async () => {
      vi.advanceTimersByTime(60_000);
      await Promise.resolve();
    });
    await act(async () => {
      vi.advanceTimersByTime(60_000);
      await Promise.resolve();
    });
    await act(async () => {
      vi.advanceTimersByTime(60_000);
      await Promise.resolve();
    });

    expect(records).toHaveLength(0);
    expect(status.textContent).toBe(entryStatusText);
    // Positive control: the countdown outside the region really did advance
    // over the five ticks - without this, the test would also pass on a
    // frozen clock that moved nothing at all.
    expect(screen.getByTestId("fallback-waiting-card").textContent).not.toBe(
      entryCardText,
    );

    observer.disconnect();
  });

  it("the live region changes exactly once, when the deadline passes", async () => {
    // Falsification: put "(in about ...)" back inside the role="status" span in fallback-waiting-card.tsx and THIS assertion must go red.
    vi.useFakeTimers();
    const deadline = Date.now() + 4 * 60_000;
    renderCard({ deadline });

    // Synchronise the shared minute clock BEFORE measuring anything, and
    // before the observer is installed, so this fire is not counted.
    //
    // `minuteClock` (lib/relative-time.ts) is a MODULE-LEVEL singleton: it
    // samples `Date.now()` at construction and on each interval fire, and a
    // (re)start re-samples it WITHOUT bumping the tick. `useSyncExternalStore`
    // re-renders on the tick, so a freshly mounted consumer keeps whatever
    // sample was left behind until a real fire moves the tick. Between tests
    // that sample is the previous test's: the 2-hour case above advances five
    // minutes, and a deadline shorter than that leak renders as already past.
    // One deliberate fire re-samples the clock onto the fake now; the deadline
    // is four minutes out so it is still ahead of that synchronised instant.
    await act(async () => {
      vi.advanceTimersByTime(60_000);
      await Promise.resolve();
    });

    const status = screen.getByRole("status");
    const entryStatusText = status.textContent;
    expect(entryStatusText).toMatch(/^Resuming at \d{1,2}:\d{2}\s?[AP]M$/i);

    const observedTexts: string[] = [];
    const observer = new MutationObserver(() => {
      observedTexts.push(status.textContent);
    });
    observer.observe(status, {
      childList: true,
      characterData: true,
      subtree: true,
    });

    await act(async () => {
      vi.advanceTimersByTime(60_000);
      await Promise.resolve();
    });
    await act(async () => {
      vi.advanceTimersByTime(60_000);
      await Promise.resolve();
    });
    await act(async () => {
      vi.advanceTimersByTime(60_000);
      await Promise.resolve();
    });
    await act(async () => {
      vi.advanceTimersByTime(60_000);
      await Promise.resolve();
    });

    expect(status.textContent).toBe("Resuming shortly…");
    expect(observedTexts).toHaveLength(1);
    expect(observedTexts[0]).toBe("Resuming shortly…");

    observer.disconnect();
  });

  it("reads Resuming shortly past the deadline and for a null deadline, never 0s", () => {
    const { unmount } = renderCard({
      deadline: Date.now() - 5_000,
    });
    expect(screen.getByRole("status").textContent).toBe("Resuming shortly…");
    expect(screen.getByRole("status").textContent).not.toMatch(/0s/);
    expect(screen.getByRole("status").textContent).not.toMatch(/-/);
    unmount();

    renderCard({ deadline: null });
    // Falsification: drop the deadline <= now branch in FallbackWaitHeadline and THIS assertion must go red.
    expect(screen.getByRole("status").textContent).toBe("Resuming shortly…");
    expect(screen.getByRole("status").textContent).not.toMatch(/0s/);
  });

  // The policy's wait cap reaches seven days, so a resume time this far out
  // needs its weekday - "Resuming at 10:34 AM" for a reset days away names
  // the wrong day.
  it("names the resume time with its weekday once it is a day or more away", () => {
    vi.useFakeTimers();
    // A fixed, far-future base so this cell cannot inherit a leaked sample
    // from an earlier test in this file: advancing a full minute-clock
    // interval past it forces an unconditional re-sample, landing `now` at
    // exactly `base + 60_000` regardless of what the shared clock read
    // before.
    const base = Date.parse("2030-01-01T00:00:00.000Z");
    vi.setSystemTime(base);
    const deadline = base + 4 * 24 * 60 * 60_000;
    renderCard({ deadline });
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    // Falsification: `formatWaitTime` always returning `formatClockTime` -
    // this reads the bare clock time instead of the weekday-qualified form.
    expect(screen.getByRole("status").textContent).toBe(
      `Resuming at ${formatResetDateTime(deadline)}`,
    );
  });

  it("sends cancel with the DTO ref on Stop waiting", () => {
    renderCard({
      deadline: Date.now() + 60_000,
    });
    fireEvent.click(screen.getByRole("button", { name: "Stop waiting" }));
    expect(mocks.mutate).toHaveBeenCalledWith({
      epicId: "epic-wait",
      chatId: "chat-wait",
      traversalId: "traversal-wait",
      revision: 5,
    });
  });

  it("omits Switch instead… when the handler is null", () => {
    renderCard({
      deadline: Date.now() + 60_000,
    });
    expect(
      screen.queryByRole("button", { name: "Switch instead…" }),
    ).toBeNull();
  });
});
