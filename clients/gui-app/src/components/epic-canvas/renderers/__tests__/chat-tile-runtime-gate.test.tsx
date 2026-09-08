import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { HOST_OLDER_THAN_DATA_FATAL_CODE } from "@traycer/protocol/host/store-formats";
import type { PreSnapshotRetryEvidence } from "@/stores/chats/chat-session-store";
import {
  useChatTileHostUpdate,
  type ChatTileHostUpdate,
} from "../use-chat-tile-host-update";
import {
  ChatTileError,
  ChatTilePreSnapshotGate,
  ChatTileStillTrying,
  STALLED_CHAT_LOAD_ATTEMPTS,
  STALLED_CHAT_LOAD_ELAPSED_MS,
  type ChatTileFatalDetails,
} from "../chat-tile-runtime-gate";

vi.mock("../use-chat-tile-host-update", () => ({
  useChatTileHostUpdate: vi.fn(),
}));

function stubHostUpdate(overrides: {
  readonly hostAppVersion: string | null;
  readonly clientAppVersion: string | null;
}): ChatTileHostUpdate {
  return {
    hostAppVersion: overrides.hostAppVersion,
    clientAppVersion: overrides.clientAppVersion,
    openHostUpdate: vi.fn(),
  };
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("<ChatTileError />", () => {
  it("shows the host-update pane and remedy when HOST_OLDER_THAN_DATA proves the host is behind", () => {
    const hostUpdate = stubHostUpdate({
      hostAppVersion: "1.2.0",
      clientAppVersion: "1.3.0",
    });
    const onRetry = vi.fn();
    const details: ChatTileFatalDetails = {
      code: HOST_OLDER_THAN_DATA_FATAL_CODE,
      reason:
        "HOST_OLDER_THAN_DATA: Chat store at ... was written by a newer build",
      upgradeGuidance: { hostShouldUpgrade: true, clientShouldUpgrade: false },
    };

    render(
      <ChatTileError
        details={details}
        hostUpdate={hostUpdate}
        onRetry={onRetry}
      />,
    );

    const pane = screen.getByTestId("chat-tile-error");
    expect(pane.getAttribute("data-error-code")).toBe(
      HOST_OLDER_THAN_DATA_FATAL_CODE,
    );
    expect(screen.getByText("Host update needed")).toBeTruthy();
    expect(
      screen.getByText("Chat store at ... was written by a newer build"),
    ).toBeTruthy();

    const updateButton = screen.getByTestId("chat-tile-host-update");
    expect(updateButton.textContent).toBe("Update now");
    fireEvent.click(updateButton);
    expect(hostUpdate.openHostUpdate).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("shows the generic pane with no update button for a plain fatal close", () => {
    const hostUpdate = stubHostUpdate({
      hostAppVersion: null,
      clientAppVersion: null,
    });
    const details: ChatTileFatalDetails = {
      code: "UNAUTHORIZED",
      reason: "CHAT_INVALID: this agent no longer exists",
      upgradeGuidance: null,
    };

    render(
      <ChatTileError
        details={details}
        hostUpdate={hostUpdate}
        onRetry={() => undefined}
      />,
    );

    expect(screen.getByTestId("chat-tile-error")).toBeTruthy();
    expect(screen.getByText("This agent could not be opened.")).toBeTruthy();
    expect(screen.getByText("this agent no longer exists")).toBeTruthy();
    expect(screen.queryByTestId("chat-tile-host-update")).toBeNull();
  });

  it("keeps the host-update remedy for a disk-format refusal even when the host is newer than the app", () => {
    // HOST_OLDER_THAN_DATA is a fact about the host's own reader - the chat
    // store on disk was written by a newer build than the one serving it -
    // so updating the app can never fix it, no matter what the two app
    // versions say.
    const hostUpdate = stubHostUpdate({
      hostAppVersion: "1.4.0",
      clientAppVersion: "1.3.0",
    });
    const details: ChatTileFatalDetails = {
      code: HOST_OLDER_THAN_DATA_FATAL_CODE,
      reason:
        "HOST_OLDER_THAN_DATA: Chat store at ... was written by a newer build",
      upgradeGuidance: { hostShouldUpgrade: true, clientShouldUpgrade: false },
    };

    render(
      <ChatTileError
        details={details}
        hostUpdate={hostUpdate}
        onRetry={() => undefined}
      />,
    );

    expect(screen.getByText("Host update needed")).toBeTruthy();
    const updateButton = screen.getByTestId("chat-tile-host-update");
    expect(updateButton.textContent).toBe("Update now");
  });

  it("offers the host-update remedy from guidance alone on a code this build has never heard of", () => {
    const hostUpdate = stubHostUpdate({
      hostAppVersion: null,
      clientAppVersion: null,
    });
    const details: ChatTileFatalDetails = {
      code: "SOME_FUTURE_CODE",
      reason: "SOME_FUTURE_CODE: the host says so",
      upgradeGuidance: { hostShouldUpgrade: true, clientShouldUpgrade: false },
    };

    render(
      <ChatTileError
        details={details}
        hostUpdate={hostUpdate}
        onRetry={() => undefined}
      />,
    );

    expect(screen.getByText("Host update needed")).toBeTruthy();
    expect(screen.getByTestId("chat-tile-host-update")).toBeTruthy();
  });

  it("keeps the generic pane for CHAT_STORE_UNUSABLE - its remedy is a repair or a support report, not a host update", () => {
    const hostUpdate = stubHostUpdate({
      hostAppVersion: "1.2.0",
      clientAppVersion: "1.3.0",
    });
    const details: ChatTileFatalDetails = {
      code: "CHAT_STORE_UNUSABLE",
      reason: "CHAT_STORE_UNUSABLE: integrity verification failed",
      upgradeGuidance: null,
    };

    render(
      <ChatTileError
        details={details}
        hostUpdate={hostUpdate}
        onRetry={() => undefined}
      />,
    );

    const pane = screen.getByTestId("chat-tile-error");
    expect(pane.getAttribute("data-error-code")).toBe("CHAT_STORE_UNUSABLE");
    expect(screen.getByText("This agent could not be opened.")).toBeTruthy();
    expect(screen.queryByTestId("chat-tile-host-update")).toBeNull();
  });

  it("offers no host-update remedy when the guidance says both legs should upgrade", () => {
    const hostUpdate = stubHostUpdate({
      hostAppVersion: null,
      clientAppVersion: null,
    });
    const details: ChatTileFatalDetails = {
      code: "SOME_OTHER_CODE",
      reason: "SOME_OTHER_CODE: both are stale",
      upgradeGuidance: { hostShouldUpgrade: true, clientShouldUpgrade: true },
    };

    render(
      <ChatTileError
        details={details}
        hostUpdate={hostUpdate}
        onRetry={() => undefined}
      />,
    );

    expect(screen.getByText("This agent could not be opened.")).toBeTruthy();
    expect(screen.queryByTestId("chat-tile-host-update")).toBeNull();
  });
});

describe("<ChatTileStillTrying />", () => {
  function retriesWith(
    overrides: Partial<PreSnapshotRetryEvidence>,
  ): PreSnapshotRetryEvidence {
    return {
      count: 3,
      firstAt: Date.now(),
      code: null,
      reason: null,
      ...overrides,
    };
  }

  it("offers the host-update remedy and names the attempt count when the host is behind", () => {
    const hostUpdate = stubHostUpdate({
      hostAppVersion: "1.2.0",
      clientAppVersion: "1.3.0",
    });

    render(
      <ChatTileStillTrying
        retries={retriesWith({ count: 3 })}
        hostUpdate={hostUpdate}
        onRetry={() => undefined}
      />,
    );

    expect(screen.getByText("Host update needed")).toBeTruthy();
    expect(screen.getByTestId("chat-tile-host-update")).toBeTruthy();
    expect(
      screen.getByText("The host has not opened this agent after 3 attempts."),
    ).toBeTruthy();
    // Not a terminal state - reconnects keep running underneath, so this
    // pane keeps the spinner's live region rather than switching to an
    // announced-once error.
    expect(screen.getByRole("status")).toBe(
      screen.getByTestId("chat-tile-still-trying"),
    );
  });

  it("shows the generic still-opening copy with no update button for equal versions", () => {
    const hostUpdate = stubHostUpdate({
      hostAppVersion: "1.3.0",
      clientAppVersion: "1.3.0",
    });
    const onRetry = vi.fn();

    render(
      <ChatTileStillTrying
        retries={retriesWith({ count: 3 })}
        hostUpdate={hostUpdate}
        onRetry={onRetry}
      />,
    );

    expect(screen.getByText("Still opening this agent")).toBeTruthy();
    expect(screen.queryByTestId("chat-tile-host-update")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("shows the generic still-opening copy with no update button when both versions are unknown", () => {
    const hostUpdate = stubHostUpdate({
      hostAppVersion: null,
      clientAppVersion: null,
    });

    render(
      <ChatTileStillTrying
        retries={retriesWith({ count: 3 })}
        hostUpdate={hostUpdate}
        onRetry={() => undefined}
      />,
    );

    expect(screen.getByText("Still opening this agent")).toBeTruthy();
    expect(screen.queryByTestId("chat-tile-host-update")).toBeNull();
  });

  it("uses singular wording for exactly one attempt", () => {
    const hostUpdate = stubHostUpdate({
      hostAppVersion: null,
      clientAppVersion: null,
    });

    render(
      <ChatTileStillTrying
        retries={retriesWith({ count: 1 })}
        hostUpdate={hostUpdate}
        onRetry={() => undefined}
      />,
    );

    expect(
      screen.getByText("The host has not opened this agent after 1 attempt."),
    ).toBeTruthy();
    expect(screen.queryByText(/after 1 attempts\./)).toBeNull();
  });
});

describe("<ChatTilePreSnapshotGate />", () => {
  beforeEach(() => {
    // The gate's threshold logic is what these cases exercise; the
    // host-update affordance is stubbed to null/null so no version-skew copy
    // interferes.
    vi.mocked(useChatTileHostUpdate).mockReturnValue({
      hostAppVersion: null,
      clientAppVersion: null,
      openHostUpdate: vi.fn(),
    });
  });

  it("renders the loading spinner when no attempt has failed yet", () => {
    render(
      <ChatTilePreSnapshotGate
        fatalClose={null}
        retries={null}
        onRetry={() => undefined}
      />,
    );

    expect(screen.getByTestId("chat-tile-loading")).toBeTruthy();
    expect(screen.queryByTestId("chat-tile-still-trying")).toBeNull();
  });

  it("stays on the spinner for a single recent failure", () => {
    vi.useFakeTimers();
    const now = Date.now();
    render(
      <ChatTilePreSnapshotGate
        fatalClose={null}
        retries={{ count: 1, firstAt: now, code: null, reason: null }}
        onRetry={() => undefined}
      />,
    );

    expect(screen.getByTestId("chat-tile-loading")).toBeTruthy();
  });

  it("switches to the stalled pane once the attempt count reaches the threshold, with no elapsed time required", () => {
    render(
      <ChatTilePreSnapshotGate
        fatalClose={null}
        retries={{
          count: STALLED_CHAT_LOAD_ATTEMPTS,
          firstAt: Date.now(),
          code: null,
          reason: null,
        }}
        onRetry={() => undefined}
      />,
    );

    expect(screen.getByTestId("chat-tile-still-trying")).toBeTruthy();
  });

  it("switches to the stalled pane once the elapsed budget passes, even with only one failed attempt", () => {
    vi.useFakeTimers();
    const now = Date.now();
    render(
      <ChatTilePreSnapshotGate
        fatalClose={null}
        retries={{ count: 1, firstAt: now, code: null, reason: null }}
        onRetry={() => undefined}
      />,
    );

    expect(screen.getByTestId("chat-tile-loading")).toBeTruthy();

    act(() => {
      vi.advanceTimersByTime(STALLED_CHAT_LOAD_ELAPSED_MS - 1);
    });
    expect(screen.getByTestId("chat-tile-loading")).toBeTruthy();

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(screen.getByTestId("chat-tile-still-trying")).toBeTruthy();
  });

  it("inherits an already-elapsed streak on mount instead of restarting the budget", () => {
    vi.useFakeTimers();
    const now = Date.now();
    render(
      <ChatTilePreSnapshotGate
        fatalClose={null}
        retries={{
          count: 1,
          firstAt: now - STALLED_CHAT_LOAD_ELAPSED_MS - 1,
          code: null,
          reason: null,
        }}
        onRetry={() => undefined}
      />,
    );

    expect(screen.getByTestId("chat-tile-still-trying")).toBeTruthy();
  });

  it("a fatal close always wins over any retry streak", () => {
    render(
      <ChatTilePreSnapshotGate
        fatalClose={{
          code: "UNAUTHORIZED",
          reason: "CHAT_INVALID: nope",
          upgradeGuidance: null,
        }}
        retries={{
          count: STALLED_CHAT_LOAD_ATTEMPTS,
          firstAt: Date.now(),
          code: null,
          reason: null,
        }}
        onRetry={() => undefined}
      />,
    );

    expect(screen.getByTestId("chat-tile-error")).toBeTruthy();
    expect(screen.queryByTestId("chat-tile-still-trying")).toBeNull();
  });

  it("stalls a host that acks chat.subscribe and then goes silent, once the elapsed budget passes", () => {
    // retries never becomes non-null here - the host never produces a
    // failure to count - so only the gate's own wait-since-mount deadline
    // can end this spin.
    vi.useFakeTimers();
    render(
      <ChatTilePreSnapshotGate
        fatalClose={null}
        retries={null}
        onRetry={() => undefined}
      />,
    );

    expect(screen.getByTestId("chat-tile-loading")).toBeTruthy();

    act(() => {
      vi.advanceTimersByTime(STALLED_CHAT_LOAD_ELAPSED_MS);
    });

    expect(screen.getByTestId("chat-tile-still-trying")).toBeTruthy();
    expect(screen.queryByTestId("chat-tile-loading")).toBeNull();
  });

  it("does not stall early for a host that acks chat.subscribe and then goes silent", () => {
    vi.useFakeTimers();
    render(
      <ChatTilePreSnapshotGate
        fatalClose={null}
        retries={null}
        onRetry={() => undefined}
      />,
    );

    act(() => {
      vi.advanceTimersByTime(STALLED_CHAT_LOAD_ELAPSED_MS - 1000);
    });

    expect(screen.getByTestId("chat-tile-loading")).toBeTruthy();
    expect(screen.queryByTestId("chat-tile-still-trying")).toBeNull();
  });

  it("says only that nothing has arrived yet when the stall carries no retry evidence", () => {
    vi.useFakeTimers();
    render(
      <ChatTilePreSnapshotGate
        fatalClose={null}
        retries={null}
        onRetry={() => undefined}
      />,
    );

    act(() => {
      vi.advanceTimersByTime(STALLED_CHAT_LOAD_ELAPSED_MS);
    });

    const pane = screen.getByTestId("chat-tile-still-trying");
    expect(
      screen.getByText("The host has not sent this agent's messages yet."),
    ).toBeTruthy();
    expect(pane.textContent).not.toMatch(/attempt/);
  });

  it("lets a fatal close outrank a stall that has no retry evidence", () => {
    vi.useFakeTimers();
    const { rerender } = render(
      <ChatTilePreSnapshotGate
        fatalClose={null}
        retries={null}
        onRetry={() => undefined}
      />,
    );

    act(() => {
      vi.advanceTimersByTime(STALLED_CHAT_LOAD_ELAPSED_MS);
    });
    expect(screen.getByTestId("chat-tile-still-trying")).toBeTruthy();

    rerender(
      <ChatTilePreSnapshotGate
        fatalClose={{
          code: "UNAUTHORIZED",
          reason: "CHAT_INVALID: nope",
          upgradeGuidance: null,
        }}
        retries={null}
        onRetry={() => undefined}
      />,
    );

    expect(screen.getByTestId("chat-tile-error")).toBeTruthy();
    expect(screen.queryByTestId("chat-tile-still-trying")).toBeNull();
  });
});
