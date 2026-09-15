import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionImportProgressToastBridge } from "@/components/layout/bridges/session-import-progress-toast-bridge";
import { useOnboardingPresenceStore } from "@/stores/onboarding/onboarding-presence-store";
import { useSessionImportRunStore } from "@/stores/session-import/session-import-run-store";

const progressToastMock = vi.hoisted(() => vi.fn());
const progressSuccessToastMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/toast/progress-toast", () => ({
  progressToast: progressToastMock,
  progressSuccessToast: progressSuccessToastMock,
}));

// The bridge names the machine a toast speaks for; the directory is app
// runtime this suite does not stand up, so the lookup answers from a table.
const HOST_LABELS: Record<string, string> = {
  "host-a": "Host A",
  "host-b": "Host B",
};
vi.mock("@/hooks/host/use-host-directory-entry", () => ({
  useHostDirectoryEntry: (hostId: string | null) =>
    hostId === null ? null : { hostId, label: HOST_LABELS[hostId] },
}));

const toastMessageMock = vi.hoisted(() => vi.fn());
const toastDismissMock = vi.hoisted(() => vi.fn());
vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), {
    message: toastMessageMock,
    dismiss: toastDismissMock,
  }),
}));

const HOST = "host-a";

function startRun(input: {
  readonly total: number;
  readonly hostId?: string;
  readonly runId?: string;
}): void {
  const hostId = input.hostId ?? HOST;
  act(() => {
    const store = useSessionImportRunStore.getState();
    store.markStarting(hostId, new Map());
    store.applyStarted(hostId, {
      runId: input.runId ?? "run-1",
      total: input.total,
      attached: false,
    });
  });
}

beforeEach(() => {
  progressToastMock.mockClear();
  progressSuccessToastMock.mockClear();
  toastMessageMock.mockClear();
  toastDismissMock.mockClear();
  useSessionImportRunStore.setState({ runs: new Map() });
  useOnboardingPresenceStore.setState({ modalOpen: false, tourBusy: false });
});

afterEach(() => {
  cleanup();
  useSessionImportRunStore.setState({ runs: new Map() });
  useOnboardingPresenceStore.setState({ modalOpen: false, tourBusy: false });
});

describe("<SessionImportProgressToastBridge />", () => {
  it("shows a persistent progress toast for a live run and resolves it into one completion summary", () => {
    render(<SessionImportProgressToastBridge />);

    startRun({ total: 3 });
    expect(progressToastMock).toHaveBeenCalledWith(
      "Importing 0 of 3…",
      expect.objectContaining({ duration: Infinity }),
    );

    act(() => {
      useSessionImportRunStore.getState().applyComplete(HOST, {
        runId: "run-1",
        counts: { imported: 2, skippedAlreadyImported: 0, failed: 1 },
      });
    });
    expect(progressSuccessToastMock).toHaveBeenCalledTimes(1);
    expect(progressSuccessToastMock).toHaveBeenCalledWith(
      "Imported 2 sessions",
      expect.objectContaining({ description: "Host A · 1 failed" }),
    );
  });

  it("says the run is starting while the host has not yet said how big it is", () => {
    render(<SessionImportProgressToastBridge />);

    act(() => {
      useSessionImportRunStore.getState().markStarting(HOST, new Map());
    });
    expect(progressToastMock).toHaveBeenCalledWith(
      "Starting import…",
      expect.anything(),
    );
  });

  it("reports a run that imported nothing as a plain transient message", () => {
    render(<SessionImportProgressToastBridge />);

    startRun({ total: 1 });
    act(() => {
      useSessionImportRunStore.getState().applyComplete(HOST, {
        runId: "run-1",
        counts: { imported: 0, skippedAlreadyImported: 1, failed: 0 },
      });
    });
    expect(progressSuccessToastMock).not.toHaveBeenCalled();
    expect(toastMessageMock).toHaveBeenCalledWith(
      "Nothing was imported",
      expect.objectContaining({ description: "Host A · 1 already in Traycer" }),
    );
  });

  it("retires the progress toast quietly when the stream is lost", () => {
    render(<SessionImportProgressToastBridge />);

    startRun({ total: 4 });
    expect(progressToastMock).toHaveBeenCalled();

    act(() => {
      useSessionImportRunStore.getState().applyError(HOST);
    });
    expect(toastDismissMock).toHaveBeenCalledTimes(1);
    expect(progressSuccessToastMock).not.toHaveBeenCalled();
    expect(toastMessageMock).not.toHaveBeenCalled();
  });

  it("keeps one independent toast per importing host", () => {
    render(<SessionImportProgressToastBridge />);

    startRun({ total: 3, hostId: "host-a", runId: "run-a" });
    startRun({ total: 8, hostId: "host-b", runId: "run-b" });
    expect(progressToastMock).toHaveBeenCalledWith(
      "Importing 0 of 3…",
      expect.objectContaining({ id: "session-import-progress:host-a" }),
    );
    expect(progressToastMock).toHaveBeenCalledWith(
      "Importing 0 of 8…",
      expect.objectContaining({ id: "session-import-progress:host-b" }),
    );

    // A's progress does not move B's line, and each names its own machine.
    progressToastMock.mockClear();
    act(() => {
      useSessionImportRunStore.getState().applyProgress("host-a", {
        runId: "run-a",
        selectionKey: "claude:s1",
        harness: "claude",
        nativeSessionId: "s1",
        outcome: { kind: "imported", epicId: "epic-1", chatId: "chat-1" },
      });
    });
    expect(progressToastMock).toHaveBeenCalledTimes(1);
    expect(progressToastMock).toHaveBeenCalledWith(
      "Importing 1 of 3…",
      expect.objectContaining({ id: "session-import-progress:host-a" }),
    );

    // A completes: its own summary, under its own id; B's toast is untouched.
    act(() => {
      useSessionImportRunStore.getState().applyComplete("host-a", {
        runId: "run-a",
        counts: { imported: 3, skippedAlreadyImported: 0, failed: 0 },
      });
    });
    expect(progressSuccessToastMock).toHaveBeenCalledWith(
      "Imported 3 sessions",
      expect.objectContaining({
        id: "session-import-progress:host-a",
        description: "Host A",
      }),
    );
    expect(toastDismissMock).not.toHaveBeenCalled();

    // Retiring B's slice takes B's progress toast down, and only B's.
    act(() => {
      useSessionImportRunStore.getState().reset("host-b");
    });
    expect(toastDismissMock).toHaveBeenCalledTimes(1);
    expect(toastDismissMock).toHaveBeenCalledWith(
      "session-import-progress:host-b",
    );
  });

  it("holds every toast while the welcome modal is open, then shows it when it closes", () => {
    act(() => {
      useOnboardingPresenceStore.getState().setModalOpen(true);
    });
    render(<SessionImportProgressToastBridge />);

    startRun({ total: 5 });
    expect(progressToastMock).not.toHaveBeenCalled();

    act(() => {
      useOnboardingPresenceStore.getState().setModalOpen(false);
    });
    expect(progressToastMock).toHaveBeenCalledWith(
      "Importing 0 of 5…",
      expect.anything(),
    );
  });

  it("holds while a tour is busy", () => {
    act(() => {
      useOnboardingPresenceStore.getState().setTourBusy(true);
    });
    render(<SessionImportProgressToastBridge />);

    startRun({ total: 5 });
    expect(progressToastMock).not.toHaveBeenCalled();

    // A paused chain releasing the hold is the tour host's own job - it is
    // the one that clears `tourBusy` - so only presence is asserted here.
    act(() => {
      useOnboardingPresenceStore.getState().setTourBusy(false);
    });
    expect(progressToastMock).toHaveBeenCalledWith(
      "Importing 0 of 5…",
      expect.anything(),
    );
  });

  it("takes an up progress toast down while busy and shows exactly one summary on release", () => {
    render(<SessionImportProgressToastBridge />);

    startRun({ total: 1 });
    expect(progressToastMock).toHaveBeenCalledTimes(1);
    act(() => {
      useOnboardingPresenceStore.getState().setTourBusy(true);
    });
    // Already-visible, `duration: Infinity`: it would otherwise sit frozen
    // over the tour.
    expect(toastDismissMock).toHaveBeenCalledWith(
      `session-import-progress:${HOST}`,
    );

    act(() => {
      useSessionImportRunStore.getState().applyComplete(HOST, {
        runId: "run-1",
        counts: { imported: 1, skippedAlreadyImported: 0, failed: 0 },
      });
    });
    expect(progressSuccessToastMock).not.toHaveBeenCalled();

    act(() => {
      useOnboardingPresenceStore.getState().setTourBusy(false);
    });
    // Our own dismiss was not read as the user closing the run's toast: the
    // summary still shows, once, and no progress toast reappears for a run
    // that has finished.
    expect(progressToastMock).toHaveBeenCalledTimes(1);
    expect(progressSuccessToastMock).toHaveBeenCalledTimes(1);
    expect(progressSuccessToastMock).toHaveBeenCalledWith(
      "Imported 1 session",
      expect.objectContaining({ description: "Host A" }),
    );
  });
});
