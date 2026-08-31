import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionImportProgressToastBridge } from "@/components/layout/bridges/session-import-progress-toast-bridge";
import { useOnboardingTourOpenStore } from "@/stores/onboarding/onboarding-tour-open-store";
import { useSessionImportRunStore } from "@/stores/session-import/session-import-run-store";

const progressToastMock = vi.hoisted(() => vi.fn());
const progressSuccessToastMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/toast/progress-toast", () => ({
  progressToast: progressToastMock,
  progressSuccessToast: progressSuccessToastMock,
}));

const toastMessageMock = vi.hoisted(() => vi.fn());
const toastDismissMock = vi.hoisted(() => vi.fn());
vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), {
    message: toastMessageMock,
    dismiss: toastDismissMock,
  }),
}));

function startRun(input: { readonly total: number }): void {
  act(() => {
    const store = useSessionImportRunStore.getState();
    store.markStarting(new Map());
    store.applyStarted({ runId: "run-1", total: input.total, attached: false });
  });
}

beforeEach(() => {
  progressToastMock.mockClear();
  progressSuccessToastMock.mockClear();
  toastMessageMock.mockClear();
  toastDismissMock.mockClear();
  useSessionImportRunStore.getState().reset();
  useOnboardingTourOpenStore.getState().setOpen(false);
});

afterEach(() => {
  cleanup();
  useSessionImportRunStore.getState().reset();
  useOnboardingTourOpenStore.getState().setOpen(false);
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
      useSessionImportRunStore.getState().applyComplete({
        runId: "run-1",
        counts: { imported: 2, skippedAlreadyImported: 0, failed: 1 },
      });
    });
    expect(progressSuccessToastMock).toHaveBeenCalledTimes(1);
    expect(progressSuccessToastMock).toHaveBeenCalledWith(
      "Imported 2 sessions",
      expect.objectContaining({ description: "1 failed" }),
    );
  });

  it("says the run is starting while the host has not yet said how big it is", () => {
    render(<SessionImportProgressToastBridge />);

    act(() => {
      useSessionImportRunStore.getState().markStarting(new Map());
    });
    expect(progressToastMock).toHaveBeenCalledWith(
      "Starting import…",
      expect.anything(),
    );
  });

  it("holds every toast while the tour is on screen, then shows it on landing", () => {
    act(() => {
      useOnboardingTourOpenStore.getState().setOpen(true);
    });
    render(<SessionImportProgressToastBridge />);

    startRun({ total: 5 });
    expect(progressToastMock).not.toHaveBeenCalled();

    act(() => {
      useOnboardingTourOpenStore.getState().setOpen(false);
    });
    expect(progressToastMock).toHaveBeenCalledWith(
      "Importing 0 of 5…",
      expect.anything(),
    );
  });

  it("reports a run that imported nothing as a plain transient message", () => {
    render(<SessionImportProgressToastBridge />);

    startRun({ total: 1 });
    act(() => {
      useSessionImportRunStore.getState().applyComplete({
        runId: "run-1",
        counts: { imported: 0, skippedAlreadyImported: 1, failed: 0 },
      });
    });
    expect(progressSuccessToastMock).not.toHaveBeenCalled();
    expect(toastMessageMock).toHaveBeenCalledWith(
      "Nothing was imported",
      expect.objectContaining({ description: "1 already in Traycer" }),
    );
  });

  it("retires the progress toast quietly when the stream is lost", () => {
    render(<SessionImportProgressToastBridge />);

    startRun({ total: 4 });
    expect(progressToastMock).toHaveBeenCalled();

    act(() => {
      useSessionImportRunStore.getState().applyError();
    });
    expect(toastDismissMock).toHaveBeenCalledTimes(1);
    expect(progressSuccessToastMock).not.toHaveBeenCalled();
    expect(toastMessageMock).not.toHaveBeenCalled();
  });
});
