import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  type RenderResult,
} from "@testing-library/react";
import type { HostLeaseSnapshot } from "@traycer-clients/shared/host-selection/selection-authority-contract";
import { HOST_OLDER_THAN_DATA_FATAL_CODE } from "@traycer/protocol/host/store-formats";
import type { HostReachability } from "@/hooks/agent/use-host-reachability";
import { useDesktopDialogStore } from "@/stores/dialogs/desktop-dialog-store";
import { useSelectionAuthorityStore } from "@/stores/host/selection-authority-store";
import type { PreSnapshotRetryEvidence } from "@/stores/chats/chat-session-store";
import {
  useChatTileHostUpdate,
  type ChatTileHostUpdate,
} from "../use-chat-tile-host-update";
import {
  ChatTilePreContent,
  type ChatTilePreContentSession,
} from "../chat-tile-runtime-gate";
import {
  CHAT_LOAD_DEADLINE_MS,
  STALLED_CHAT_LOAD_ATTEMPTS,
  STALLED_CHAT_LOAD_ELAPSED_MS,
  type ChatLoadWait,
  type ChatTilePreContentFrame,
} from "../chat-pre-content";

vi.mock("../use-chat-tile-host-update", () => ({
  useChatTileHostUpdate: vi.fn(),
}));

// The lease is keyed by the tab's host. The real hook reads a context this
// suite has no reason to mount a provider for.
vi.mock(
  "@/components/epic-canvas/hooks/use-tab-host-id",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@/components/epic-canvas/hooks/use-tab-host-id")
    >()),
    useTabHostId: () => "host-1",
  }),
);

const HOST_ID = "host-1";
const LABEL = "MacBook Pro";
const TEST_ID = "chat-tile-pre-content-chat-1";
const SPINNER_ID = `${TEST_ID}-spinner`;
const INITIAL_DIALOG_STATE = useDesktopDialogStore.getState();

const READY: HostLeaseSnapshot = {
  hostId: HOST_ID,
  status: "ready",
  dead: null,
};

function publishLease(lease: HostLeaseSnapshot | null): void {
  useSelectionAuthorityStore.getState().applyKernelSnapshot({
    attached: true,
    preferredHostId: HOST_ID,
    targetHostId: HOST_ID,
    effectiveHostId: HOST_ID,
    leases: lease === null ? [] : [lease],
    selectionRevision: 1,
  });
}

function stubHostUpdate(
  hostAppVersion: string | null,
  clientAppVersion: string | null,
): ChatTileHostUpdate {
  const stub: ChatTileHostUpdate = {
    hostAppVersion,
    clientAppVersion,
    openHostUpdate: vi.fn(),
  };
  vi.mocked(useChatTileHostUpdate).mockReturnValue(stub);
  return stub;
}

function reachability(status: HostReachability["status"]): HostReachability {
  return {
    status,
    hostLabel: LABEL,
    unavailability: status === "unreachable" ? "offline" : null,
    basis: "directory",
    hostKind: "local",
  };
}

/** The wait `ChatTile` records at its first render. */
function firstRenderWait(): ChatLoadWait {
  return { startedAt: Date.now(), attemptsBefore: 0, inheritsStreak: true };
}

function frameFor(
  wait: ChatLoadWait,
  status: HostReachability["status"],
  restartWait: (attemptsNow: number) => void,
): ChatTilePreContentFrame {
  return { wait, restartWait, reachability: reachability(status) };
}

function session(
  overrides: Partial<ChatTilePreContentSession>,
): ChatTilePreContentSession {
  return {
    fatalClose: null,
    connectionStatus: "connecting",
    retries: null,
    reloadStartedAt: null,
    onRetry: vi.fn(),
    ...overrides,
  };
}

function streak(
  count: number,
  firstAt: number,
  code: string | null,
): PreSnapshotRetryEvidence {
  return {
    count,
    firstAt,
    code,
    reason: code === null ? null : `${code}: refused`,
  };
}

function renderPreContent(
  frame: ChatTilePreContentFrame,
  sessionValue: ChatTilePreContentSession | null,
): RenderResult {
  return render(
    <ChatTilePreContent
      testId={TEST_ID}
      frame={frame}
      session={sessionValue}
    />,
  );
}

function body(): HTMLElement {
  return screen.getByTestId(TEST_ID);
}

function arm(): string | null {
  return body().getAttribute("data-arm");
}

beforeEach(() => {
  stubHostUpdate(null, null);
  publishLease(READY);
  useDesktopDialogStore.setState({ reportIssueAvailable: true });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  useSelectionAuthorityStore.getState().reset();
  useDesktopDialogStore.setState(INITIAL_DIALOG_STATE, true);
});

describe("<ChatTilePreContent />: the calm waits", () => {
  it("names the host from the first frame, spins politely, and offers nothing", () => {
    renderPreContent(
      frameFor(firstRenderWait(), "reachable", vi.fn()),
      session({}),
    );

    expect(arm()).toBe("loading");
    expect(body().getAttribute("role")).toBe("status");
    expect(body().getAttribute("aria-live")).toBe("polite");
    expect(
      screen.getByText(`Loading this agent from "${LABEL}"…`),
    ).toBeTruthy();
    expect(screen.getByTestId(SPINNER_ID)).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("adds the taking-longer line at 20 s, and the buttons only at 60 s", () => {
    vi.useFakeTimers();
    renderPreContent(
      frameFor(firstRenderWait(), "reachable", vi.fn()),
      session({ connectionStatus: "open" }),
    );
    const line = `Taking longer than usual. It will appear here as soon as "${LABEL}" sends it.`;

    act(() => {
      vi.advanceTimersByTime(STALLED_CHAT_LOAD_ELAPSED_MS - 1);
    });
    expect(screen.queryByText(line)).toBeNull();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(screen.getByText(line)).toBeTruthy();
    expect(arm()).toBe("loading");
    expect(screen.queryByRole("button")).toBeNull();

    act(() => {
      vi.advanceTimersByTime(
        CHAT_LOAD_DEADLINE_MS - STALLED_CHAT_LOAD_ELAPSED_MS - 1,
      );
    });
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(arm()).toBe("taking-too-long");
    expect(screen.getByText("This agent hasn't loaded yet.")).toBeTruthy();
    expect(
      screen.getByText(
        `"${LABEL}" is connected but hasn't sent it yet. It will appear here as soon as it arrives.`,
      ),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Report issue" })).toBeTruthy();
    // Not an error: loading continues underneath, so the spinner and the
    // polite live region stay.
    expect(screen.getByTestId(SPINNER_ID)).toBeTruthy();
    expect(body().getAttribute("role")).toBe("status");
  });

  it("keeps the wait when the handle arrives at 40 s, so the buttons still come 60 s after the first render", () => {
    vi.useFakeTimers();
    const frame = frameFor(firstRenderWait(), "reachable", vi.fn());
    // Two different parents, so React mounts a NEW instance for the handle
    // phase - as `ChatTile`'s handle-pending branch and its session view do.
    const { rerender } = render(
      <div>
        <ChatTilePreContent testId={TEST_ID} frame={frame} session={null} />
      </div>,
    );
    const began = body().getAttribute("data-wait-began-at");
    expect(body().getAttribute("data-has-handle")).toBe("false");

    act(() => {
      vi.advanceTimersByTime(40_000);
    });
    rerender(
      <section>
        <ChatTilePreContent
          testId={TEST_ID}
          frame={frame}
          session={session({})}
        />
      </section>,
    );
    expect(body().getAttribute("data-has-handle")).toBe("true");
    expect(body().getAttribute("data-wait-began-at")).toBe(began);

    act(() => {
      vi.advanceTimersByTime(CHAT_LOAD_DEADLINE_MS - 40_000 - 1);
    });
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  });

  // The wake pulse, the plan-restricted reprobe and the host-version move all
  // call the store's automatic `retry()`, which clears `snapshotLoaded` on a
  // tile whose transcript is on screen. The tile's anchor is its first render,
  // so a tile open for an hour would otherwise show the "hasn't loaded yet"
  // card on the replacement subscription's FIRST frame.
  it("gives an automatic reload its own 60 s, however long the tile has been open", () => {
    vi.useFakeTimers();
    const frame = frameFor(firstRenderWait(), "reachable", vi.fn());
    const { rerender } = renderPreContent(frame, session({}));
    const firstWaitBeganAt = body().getAttribute("data-wait-began-at");

    // An hour of transcript on screen, then the stream goes terminal and the
    // wake pulse re-subscribes.
    act(() => {
      vi.advanceTimersByTime(3_600_000);
    });
    const reloadStartedAt = Date.now();
    rerender(
      <ChatTilePreContent
        testId={TEST_ID}
        frame={frame}
        session={session({ reloadStartedAt })}
      />,
    );

    expect(body().getAttribute("data-wait-began-at")).toBe(
      String(reloadStartedAt),
    );
    expect(body().getAttribute("data-wait-began-at")).not.toBe(
      firstWaitBeganAt,
    );
    expect(arm()).toBe("loading");
    expect(
      screen.getByText(`Loading this agent from "${LABEL}"…`),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();

    act(() => {
      vi.advanceTimersByTime(CHAT_LOAD_DEADLINE_MS - 1);
    });
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(arm()).toBe("taking-too-long");
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  });

  it("does not stop at the shared 15 s tile budget without a handle, and offers no Try again at the deadline", () => {
    vi.useFakeTimers();
    renderPreContent(frameFor(firstRenderWait(), "reachable", vi.fn()), null);

    act(() => {
      vi.advanceTimersByTime(15_000);
    });
    expect(arm()).toBe("loading");
    expect(screen.queryByRole("button")).toBeNull();

    act(() => {
      vi.advanceTimersByTime(CHAT_LOAD_DEADLINE_MS - 15_000);
    });
    expect(arm()).toBe("taking-too-long");
    expect(screen.getByText(`"${LABEL}" hasn't answered.`)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
    expect(screen.getByRole("button", { name: "Report issue" })).toBeTruthy();
    expect(screen.queryByTestId(SPINNER_ID)).toBeNull();
  });

  it("keeps three refusals from a host that is not up in waiting-for-host, with no buttons", () => {
    publishLease({ hostId: HOST_ID, status: "connecting", dead: null });
    renderPreContent(
      frameFor(firstRenderWait(), "host-starting", vi.fn()),
      session({
        connectionStatus: "reconnecting",
        retries: streak(STALLED_CHAT_LOAD_ATTEMPTS, Date.now(), null),
      }),
    );

    expect(arm()).toBe("waiting-for-host");
    expect(
      screen.getByText(`This agent will open once "${LABEL}" is ready.`),
    ).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("says what happens to this agent under a starting strip, and never repeats the strip", () => {
    vi.useFakeTimers();
    publishLease({
      hostId: HOST_ID,
      status: "restarting-expected",
      dead: null,
    });
    renderPreContent(
      frameFor(firstRenderWait(), "host-starting", vi.fn()),
      session({
        connectionStatus: "reconnecting",
        retries: streak(1, Date.now(), null),
      }),
    );

    expect(
      screen.getByText(`This agent will open once "${LABEL}" is ready.`),
    ).toBeTruthy();
    expect(body().textContent).not.toContain("Waiting for the host to start");
    act(() => {
      vi.advanceTimersByTime(STALLED_CHAT_LOAD_ELAPSED_MS);
    });
    expect(screen.getByText("This keeps retrying on its own.")).toBeTruthy();
    expect(body().textContent).not.toContain("Waiting for the host to start");
  });

  it("neither spins nor says Waiting or Loading under an offline strip with no handle", () => {
    publishLease(null);
    renderPreContent(frameFor(firstRenderWait(), "unreachable", vi.fn()), null);

    expect(arm()).toBe("waiting-for-host");
    expect(
      screen.getByText(`This agent will open once "${LABEL}" is available.`),
    ).toBeTruthy();
    expect(screen.queryByTestId(SPINNER_ID)).toBeNull();
    expect(body().textContent).not.toMatch(/Waiting|Loading/);
  });
});

describe("<ChatTilePreContent />: escalation and Try again", () => {
  it("inherits an already-elapsed streak on mount instead of restarting the budget", () => {
    vi.useFakeTimers();
    const firstAt = Date.now() - CHAT_LOAD_DEADLINE_MS - 1;
    renderPreContent(
      frameFor(firstRenderWait(), "reachable", vi.fn()),
      session({
        connectionStatus: "reconnecting",
        retries: streak(1, firstAt, null),
      }),
    );

    expect(arm()).toBe("taking-too-long");
    expect(body().getAttribute("data-wait-began-at")).toBe(String(firstAt));
  });

  it("escalates a store with nothing retrying it at once, without a spinner", () => {
    renderPreContent(
      frameFor(firstRenderWait(), "reachable", vi.fn()),
      session({ connectionStatus: "closed" }),
    );

    expect(arm()).toBe("taking-too-long");
    expect(
      screen.getByText(`The connection to "${LABEL}" was lost.`),
    ).toBeTruthy();
    expect(screen.queryByTestId(SPINNER_ID)).toBeNull();
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  });

  it("sends Try again to the person's retry after beginning a new wait, which returns the tile to loading", () => {
    vi.useFakeTimers();
    const restartWait = vi.fn<(attemptsNow: number) => void>();
    const onRetry = vi.fn();
    const refusals = streak(
      STALLED_CHAT_LOAD_ATTEMPTS,
      Date.now(),
      "SESSION_CLOSED",
    );
    const { rerender } = renderPreContent(
      frameFor(firstRenderWait(), "reachable", restartWait),
      session({ connectionStatus: "reconnecting", retries: refusals, onRetry }),
    );
    expect(arm()).toBe("taking-too-long");
    expect(
      screen.getByText(
        `"${LABEL}" has not opened it after 3 attempts. This keeps retrying on its own.`,
      ),
    ).toBeTruthy();
    expect(body().getAttribute("data-error-code")).toBe("SESSION_CLOSED");

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(restartWait).toHaveBeenCalledWith(STALLED_CHAT_LOAD_ATTEMPTS);
    // The new wait first: the retry can throw.
    expect(restartWait.mock.invocationCallOrder[0]).toBeLessThan(
      onRetry.mock.invocationCallOrder[0] ?? Number.NaN,
    );

    // `ChatTile` answers with a new wait; the store keeps its streak.
    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    const clickWait: ChatLoadWait = {
      startedAt: Date.now(),
      attemptsBefore: STALLED_CHAT_LOAD_ATTEMPTS,
      inheritsStreak: false,
    };
    rerender(
      <ChatTilePreContent
        testId={TEST_ID}
        frame={frameFor(clickWait, "reachable", restartWait)}
        session={session({
          connectionStatus: "connecting",
          retries: refusals,
          onRetry,
        })}
      />,
    );
    expect(arm()).toBe("loading");
    expect(body().getAttribute("data-wait-began-at")).toBe(
      String(clickWait.startedAt),
    );
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  });

  it("starts a fresh budget after a Try again from the fatal body - time spent on the error was not loading time", () => {
    vi.useFakeTimers();
    const restartWait = vi.fn<(attemptsNow: number) => void>();
    const onRetry = vi.fn();
    const { rerender } = renderPreContent(
      frameFor(firstRenderWait(), "reachable", restartWait),
      session({
        connectionStatus: "closed",
        fatalClose: {
          code: "CHAT_INVALID",
          reason: "CHAT_INVALID: nope",
          upgradeGuidance: null,
        },
        onRetry,
      }),
    );
    expect(arm()).toBe("failed");

    act(() => {
      vi.advanceTimersByTime(CHAT_LOAD_DEADLINE_MS + 1);
    });
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(restartWait).toHaveBeenCalledWith(0);

    const clickWait: ChatLoadWait = {
      startedAt: Date.now(),
      attemptsBefore: 0,
      inheritsStreak: false,
    };
    rerender(
      <ChatTilePreContent
        testId={TEST_ID}
        frame={frameFor(clickWait, "reachable", restartWait)}
        session={session({ connectionStatus: "connecting", onRetry })}
      />,
    );
    expect(arm()).toBe("loading");
    act(() => {
      vi.advanceTimersByTime(CHAT_LOAD_DEADLINE_MS - 1);
    });
    expect(arm()).toBe("loading");
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(arm()).toBe("taking-too-long");
  });

  it("offers the host update on a stalled load only when the versions prove the host is behind", () => {
    stubHostUpdate("1.2.0", "1.3.0");
    const { unmount } = renderPreContent(
      frameFor(firstRenderWait(), "reachable", vi.fn()),
      session({
        connectionStatus: "reconnecting",
        retries: streak(STALLED_CHAT_LOAD_ATTEMPTS, Date.now(), null),
      }),
    );
    expect(screen.getByText("Host update needed")).toBeTruthy();
    expect(screen.getByTestId("chat-tile-host-update").textContent).toBe(
      "Update now",
    );
    unmount();

    stubHostUpdate("1.3.0", "1.3.0");
    renderPreContent(
      frameFor(firstRenderWait(), "reachable", vi.fn()),
      session({
        connectionStatus: "reconnecting",
        retries: streak(STALLED_CHAT_LOAD_ATTEMPTS, Date.now(), null),
      }),
    );
    expect(screen.getByText("This agent hasn't loaded yet.")).toBeTruthy();
    expect(screen.queryByTestId("chat-tile-host-update")).toBeNull();
  });

  it("carries the host's code and every stage token in the report", () => {
    vi.useFakeTimers();
    renderPreContent(
      frameFor(firstRenderWait(), "reachable", vi.fn()),
      session({
        connectionStatus: "reconnecting",
        retries: streak(
          STALLED_CHAT_LOAD_ATTEMPTS,
          Date.now(),
          "SESSION_NOT_READY",
        ),
      }),
    );
    act(() => {
      vi.advanceTimersByTime(12_345);
    });

    fireEvent.click(screen.getByRole("button", { name: "Report issue" }));
    expect(
      useDesktopDialogStore.getState().reportIssueDraftContext?.publicPrefill,
    ).toEqual({
      title: "This agent hasn't loaded",
      message:
        "stage=taking-too-long evidence=refused attempts=3 elapsedS=12 stream=reconnecting lease=ready strip=none",
      code: "SESSION_NOT_READY",
      source: "Chat",
    });
  });
});

describe("<ChatTilePreContent />: verdicts", () => {
  it("lets a fatal close win over a dead lease, a refusal streak and the deadline", () => {
    publishLease({
      hostId: HOST_ID,
      status: "dead",
      dead: { reason: "offline" },
    });
    const now = Date.now();
    renderPreContent(
      frameFor(
        {
          startedAt: now - CHAT_LOAD_DEADLINE_MS,
          attemptsBefore: 0,
          inheritsStreak: true,
        },
        "unreachable",
        vi.fn(),
      ),
      session({
        connectionStatus: "closed",
        fatalClose: {
          code: "CHAT_INVALID",
          reason: "CHAT_INVALID: this agent no longer exists",
          upgradeGuidance: null,
        },
        retries: streak(5, now - 1, null),
      }),
    );

    expect(arm()).toBe("failed");
    expect(screen.getByText("This agent could not be opened.")).toBeTruthy();
    expect(screen.getByText("this agent no longer exists")).toBeTruthy();
    expect(body().getAttribute("data-error-code")).toBe("CHAT_INVALID");
    // The attempt is over: no spinner, and the live region ESCALATES rather
    // than going away. The wait and the verdict are the same element, so a
    // region that stops being live at the swap announces nothing.
    expect(screen.queryByTestId(SPINNER_ID)).toBeNull();
    expect(body().getAttribute("role")).toBe("alert");
    expect(body().getAttribute("aria-live")).toBe("assertive");
  });

  it("offers the host update and Try again for HOST_OLDER_THAN_DATA", () => {
    const hostUpdate = stubHostUpdate("1.2.0", "1.3.0");
    const onRetry = vi.fn();
    renderPreContent(
      frameFor(firstRenderWait(), "reachable", vi.fn()),
      session({
        connectionStatus: "closed",
        fatalClose: {
          code: HOST_OLDER_THAN_DATA_FATAL_CODE,
          reason:
            "HOST_OLDER_THAN_DATA: Chat store at ... was written by a newer build",
          upgradeGuidance: {
            hostShouldUpgrade: true,
            clientShouldUpgrade: false,
          },
        },
        onRetry,
      }),
    );

    expect(arm()).toBe("failed-host-update");
    expect(screen.getByText("Host update needed")).toBeTruthy();
    expect(
      screen.getByText("Chat store at ... was written by a newer build"),
    ).toBeTruthy();
    const update = screen.getByTestId("chat-tile-host-update");
    expect(update.textContent).toBe("Update now");
    fireEvent.click(update);
    expect(hostUpdate.openHostUpdate).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("says the lease's sentence for a dead host, with Try again only once a handle exists", () => {
    publishLease({
      hostId: HOST_ID,
      status: "dead",
      dead: { reason: "removed" },
    });
    const frame = frameFor(firstRenderWait(), "unreachable", vi.fn());
    const { rerender } = renderPreContent(frame, null);

    expect(arm()).toBe("host-gone");
    expect(
      screen.getByText(
        `Host "${LABEL}" was removed from your account, so this agent can't be loaded.`,
      ),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
    expect(screen.getByRole("button", { name: "Report issue" })).toBeTruthy();
    expect(screen.queryByTestId(SPINNER_ID)).toBeNull();

    rerender(
      <ChatTilePreContent
        testId={TEST_ID}
        frame={frame}
        session={session({})}
      />,
    );
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  });
});
