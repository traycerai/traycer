import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { SessionImportProgress } from "@/components/session-import/session-import-progress";
import { sessionImportTone } from "@/components/session-import/session-import-tone";
import {
  progressEntryFrom,
  useSessionImportRunStore,
} from "@/stores/session-import/session-import-run-store";

/**
 * The two things the progress view has to get right about WHOSE run it is
 * showing and WHERE the tasks will appear - both invisible to the wizard
 * tests, which never see an attached run or the onboarding ground. Also
 * covers the complete-run summary's failure grouping, which lives here rather
 * than in the model suite because the toggle is DOM behaviour.
 */
describe("SessionImportProgress", () => {
  beforeEach(() => {
    useSessionImportRunStore.getState().reset();
  });

  afterEach(() => {
    cleanup();
  });

  it("says an import is already running on this machine while attached, with no 'you can close this' copy", () => {
    useSessionImportRunStore.getState().markStarting(new Map());
    useSessionImportRunStore
      .getState()
      .applyStarted({ runId: "run-1", total: 4, attached: true });

    render(<SessionImportProgress tone={sessionImportTone("dialog")} />);

    // Queried by role: the running view is a live region, so what a screen
    // reader is told and what the dialog shows are the same assertion.
    const progress = screen.getByRole("status");
    expect(
      within(progress).getByText(
        "An import is already running on this machine.",
      ),
    ).toBeTruthy();
    expect(within(progress).getByText("Importing 0 of 4…")).toBeTruthy();
    expect(progress.textContent).not.toContain("You can close this");
  });

  it("shows no attached notice, and still no 'you can close this' copy, for a run this window started", () => {
    useSessionImportRunStore.getState().markStarting(new Map());
    useSessionImportRunStore
      .getState()
      .applyStarted({ runId: "run-1", total: 4, attached: false });

    render(<SessionImportProgress tone={sessionImportTone("dialog")} />);

    const progress = screen.getByRole("status");
    expect(screen.queryByTestId("session-import-progress-attached")).toBeNull();
    expect(progress.textContent).not.toContain(
      "An import is already running on this machine.",
    );
    expect(progress.textContent).not.toContain("You can close this");
  });

  it("shows the lost-connection copy, distinct from the running and complete views", () => {
    useSessionImportRunStore.getState().markStarting(new Map());
    useSessionImportRunStore
      .getState()
      .applyStarted({ runId: "run-1", total: 4, attached: false });
    useSessionImportRunStore.getState().applyError();

    render(<SessionImportProgress tone={sessionImportTone("dialog")} />);

    expect(
      screen.getByText(
        "Traycer lost connection to the host importing the tasks.",
      ),
    ).toBeTruthy();
    expect(
      screen.getByText("The import keeps running on your machine."),
    ).toBeTruthy();
  });

  it("points the tour at the end of onboarding and the dialog at the task list", () => {
    useSessionImportRunStore.getState().markStarting(new Map());
    useSessionImportRunStore
      .getState()
      .applyStarted({ runId: "run-1", total: 1, attached: false });
    useSessionImportRunStore.getState().applyComplete({
      runId: "run-1",
      counts: { imported: 1, skippedAlreadyImported: 0, failed: 0 },
    });

    render(<SessionImportProgress tone={sessionImportTone("onboarding")} />);
    expect(
      screen.getByText(
        "They'll be in your task list when you finish the tour.",
      ),
    ).toBeTruthy();

    cleanup();
    render(<SessionImportProgress tone={sessionImportTone("dialog")} />);
    expect(
      screen.getByText("Your tasks are in the list on the left."),
    ).toBeTruthy();
  });

  it("says nothing was imported and omits the destination line when nothing landed", () => {
    useSessionImportRunStore.getState().markStarting(new Map());
    useSessionImportRunStore
      .getState()
      .applyStarted({ runId: "run-1", total: 1, attached: false });
    useSessionImportRunStore.getState().applyComplete({
      runId: "run-1",
      counts: { imported: 0, skippedAlreadyImported: 0, failed: 0 },
    });

    render(<SessionImportProgress tone={sessionImportTone("dialog")} />);

    expect(screen.getByText("Nothing was imported")).toBeTruthy();
    expect(
      screen.queryByText("Your tasks are in the list on the left."),
    ).toBeNull();
  });

  it("reports how many were already in Traycer", () => {
    useSessionImportRunStore.getState().markStarting(new Map());
    useSessionImportRunStore
      .getState()
      .applyStarted({ runId: "run-1", total: 1, attached: false });
    useSessionImportRunStore.getState().applyComplete({
      runId: "run-1",
      counts: { imported: 0, skippedAlreadyImported: 3, failed: 0 },
    });

    render(<SessionImportProgress tone={sessionImportTone("dialog")} />);

    expect(screen.getByText("3 already in Traycer")).toBeTruthy();
  });

  it("groups a complete run's failures by reason and keeps sessions hidden until the toggle is clicked", () => {
    useSessionImportRunStore.getState().markStarting(
      new Map([
        ["claude:s1", "Broken session one"],
        ["claude:s2", "Broken session two"],
        ["codex:s3", "Empty session"],
      ]),
    );
    useSessionImportRunStore
      .getState()
      .applyStarted({ runId: "run-1", total: 3, attached: false });
    useSessionImportRunStore.getState().applyProgress(
      progressEntryFrom({
        runId: "run-1",
        harness: "claude",
        nativeSessionId: "s1",
        outcome: {
          kind: "failed",
          reason: "source_unreadable",
          detail: "disk error",
        },
      }),
    );
    useSessionImportRunStore.getState().applyProgress(
      progressEntryFrom({
        runId: "run-1",
        harness: "claude",
        nativeSessionId: "s2",
        outcome: {
          kind: "failed",
          reason: "source_unreadable",
          detail: "permission denied",
        },
      }),
    );
    useSessionImportRunStore.getState().applyProgress(
      progressEntryFrom({
        runId: "run-1",
        harness: "codex",
        nativeSessionId: "s3",
        outcome: { kind: "failed", reason: "source_empty", detail: "" },
      }),
    );
    useSessionImportRunStore.getState().applyComplete({
      runId: "run-1",
      counts: { imported: 0, skippedAlreadyImported: 0, failed: 3 },
    });

    render(<SessionImportProgress tone={sessionImportTone("dialog")} />);

    // One line, one toggle; the reasons are sections behind it.
    expect(screen.getByTestId("session-import-not-imported").textContent).toBe(
      "Not imported: 3 sessions",
    );
    expect(screen.queryByTestId("session-import-failure-group")).toBeNull();
    expect(screen.queryByText("Broken session one")).toBeNull();

    const toggle = screen.getByTestId("session-import-failure-toggle");
    expect(toggle.textContent).toBe("Show details");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(toggle);

    expect(toggle.textContent).toBe("Hide details");
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    const groups = screen.getAllByTestId("session-import-failure-group");
    // Canonical reason order, not arrival order: source_unreadable first.
    expect(groups.map((group) => group.getAttribute("data-reason"))).toEqual([
      "source_unreadable",
      "source_empty",
    ]);
    expect(screen.getByText("Could not be read (2)")).toBeTruthy();
    expect(screen.getByText("No messages (1)")).toBeTruthy();
    expect(screen.getByText("Broken session one")).toBeTruthy();
    expect(screen.getByText("Broken session two")).toBeTruthy();
    expect(screen.getByText("Empty session")).toBeTruthy();
    // The host's detail rides only the rows where it varies per session.
    expect(screen.getByText("disk error")).toBeTruthy();
    expect(
      screen.queryByText("the session holds no message worth a chat"),
    ).toBeNull();

    fireEvent.click(toggle);

    expect(toggle.textContent).toBe("Show details");
    expect(screen.queryByText("Broken session one")).toBeNull();
  });
});
