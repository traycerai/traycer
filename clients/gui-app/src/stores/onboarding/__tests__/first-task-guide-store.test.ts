import { beforeEach, describe, expect, it } from "vitest";
import type { SessionImportOutcome } from "@traycer/protocol/host/session-import/run";
import { sessionImportSelectionKey } from "@/components/session-import/session-import-model";
import {
  firstTaskImports,
  useFirstTaskGuideStore,
} from "@/stores/onboarding/first-task-guide-store";
import {
  progressEntryFrom,
  useSessionImportRunStore,
} from "@/stores/session-import/session-import-run-store";

const HOST_A = "host-a";
const HOST_B = "host-b";

function startRun(
  hostId: string,
  runId: string,
  nativeSessionId: string,
): void {
  const selectionKey = sessionImportSelectionKey("claude", nativeSessionId);
  const store = useSessionImportRunStore.getState();
  store.markStarting(
    hostId,
    new Map([[selectionKey, `Title ${nativeSessionId}`]]),
  );
  store.applyStarted(hostId, { runId, total: 1, attached: false });
}

function addOutcome(
  hostId: string,
  runId: string,
  nativeSessionId: string,
  outcome: SessionImportOutcome,
): void {
  useSessionImportRunStore.getState().applyProgress(
    hostId,
    progressEntryFrom({
      runId,
      harness: "claude",
      nativeSessionId,
      outcome,
    }),
  );
}

function completeRun(hostId: string, runId: string): void {
  useSessionImportRunStore.getState().applyComplete(hostId, {
    runId,
    counts: { imported: 1, skippedAlreadyImported: 0, failed: 0 },
  });
}

describe("useFirstTaskGuideStore", () => {
  beforeEach(() => {
    useFirstTaskGuideStore.setState({
      status: "inactive",
      imports: new Map(),
      workspaceReviewed: false,
      acknowledgedHints: new Set(),
    });
    useSessionImportRunStore.setState({ runs: new Map() });
  });

  it("stays inactive until activated and remembers only explicitly selected imports", () => {
    startRun(HOST_A, "run-a", "session-a");
    addOutcome(HOST_A, "run-a", "session-a", {
      kind: "imported",
      epicId: "epic-a",
      chatId: "chat-a",
    });
    startRun(HOST_B, "run-b", "session-b");
    addOutcome(HOST_B, "run-b", "session-b", {
      kind: "imported",
      epicId: "epic-b",
      chatId: "chat-b",
    });

    const guide = useFirstTaskGuideStore.getState();
    guide.observeImports(useSessionImportRunStore.getState());
    expect(useFirstTaskGuideStore.getState().imports.size).toBe(0);
    guide.messageSubmitted(HOST_A, "chat-a");
    expect(useFirstTaskGuideStore.getState().status).toBe("inactive");

    guide.rememberImport(HOST_A);
    expect(
      firstTaskImports(useFirstTaskGuideStore.getState().imports),
    ).toMatchObject([
      { hostId: HOST_A, chatId: "chat-a", title: "Title session-a" },
    ]);
    expect(useFirstTaskGuideStore.getState().imports.has(HOST_B)).toBe(false);

    useFirstTaskGuideStore.getState().activate();
    expect(useFirstTaskGuideStore.getState().status).toBe("active");
  });

  it("isolates hosts and run ids, retaining completed outcomes after reset", () => {
    startRun(HOST_A, "run-a1", "session-a");
    addOutcome(HOST_A, "run-a1", "session-a", {
      kind: "imported",
      epicId: "epic-a",
      chatId: "chat-a",
    });
    completeRun(HOST_A, "run-a1");
    useFirstTaskGuideStore.getState().rememberImport(HOST_A);

    startRun(HOST_B, "run-b1", "session-b");
    addOutcome(HOST_B, "run-b1", "session-b", {
      kind: "imported",
      epicId: "epic-b",
      chatId: "chat-b",
    });
    useFirstTaskGuideStore
      .getState()
      .observeImports(useSessionImportRunStore.getState());
    expect(useFirstTaskGuideStore.getState().imports.has(HOST_B)).toBe(false);

    startRun(HOST_A, "run-a2", "session-a2");
    addOutcome(HOST_A, "run-a2", "session-a2", {
      kind: "imported",
      epicId: "epic-a2",
      chatId: "chat-a2",
    });
    useFirstTaskGuideStore
      .getState()
      .observeImports(useSessionImportRunStore.getState());
    expect(
      firstTaskImports(useFirstTaskGuideStore.getState().imports),
    ).toMatchObject([{ hostId: HOST_A, chatId: "chat-a" }]);

    useSessionImportRunStore.getState().reset(HOST_A);
    useFirstTaskGuideStore
      .getState()
      .observeImports(useSessionImportRunStore.getState());
    const imports = useFirstTaskGuideStore.getState().imports;
    expect(imports.get(HOST_A)?.status).toBe("complete");
    expect(firstTaskImports(imports)).toMatchObject([
      { hostId: HOST_A, epicId: "epic-a", chatId: "chat-a" },
    ]);
  });

  it("keeps both runs' tasks when the host imports more after a completed run", () => {
    startRun(HOST_A, "run-a1", "session-a");
    addOutcome(HOST_A, "run-a1", "session-a", {
      kind: "imported",
      epicId: "epic-a",
      chatId: "chat-a",
    });
    completeRun(HOST_A, "run-a1");
    useFirstTaskGuideStore.getState().rememberImport(HOST_A);
    useFirstTaskGuideStore.getState().activate();

    // "Import more" on the summary card: the run store is retired and a second
    // run starts on the same host.
    useSessionImportRunStore.getState().reset(HOST_A);
    startRun(HOST_A, "run-a2", "session-a2");
    useFirstTaskGuideStore.getState().rememberImport(HOST_A);
    addOutcome(HOST_A, "run-a2", "session-a2", {
      kind: "imported",
      epicId: "epic-a2",
      chatId: "chat-a2",
    });
    completeRun(HOST_A, "run-a2");
    useFirstTaskGuideStore
      .getState()
      .observeImports(useSessionImportRunStore.getState());

    expect(
      firstTaskImports(useFirstTaskGuideStore.getState().imports),
    ).toMatchObject([
      { chatId: "chat-a", title: "Title session-a" },
      { chatId: "chat-a2", title: "Title session-a2" },
    ]);
    // Folding the same run again is the same slice: an unrelated frame of the
    // import store must not mint a new map for this one's readers.
    const folded = useFirstTaskGuideStore.getState().imports;
    useFirstTaskGuideStore
      .getState()
      .observeImports(useSessionImportRunStore.getState());
    expect(useFirstTaskGuideStore.getState().imports).toBe(folded);

    // The first run's chats are still the guide's own, so continuing one of
    // them still finishes the guide.
    useFirstTaskGuideStore.getState().messageSubmitted(HOST_A, "chat-a");
    expect(useFirstTaskGuideStore.getState().status).toBe("finished");
  });

  it("keeps imported and skipped outcomes but omits failed outcomes", () => {
    startRun(HOST_A, "run-a", "imported-session");
    addOutcome(HOST_A, "run-a", "imported-session", {
      kind: "imported",
      epicId: "epic-imported",
      chatId: "chat-imported",
    });
    addOutcome(HOST_A, "run-a", "skipped-session", {
      kind: "skipped_already_imported",
      epicId: "epic-skipped",
      chatId: "chat-skipped",
    });
    addOutcome(HOST_A, "run-a", "failed-session", {
      kind: "failed",
      reason: "source_unreadable",
      detail: "unreadable source",
    });

    useFirstTaskGuideStore.getState().rememberImport(HOST_A);

    expect(
      firstTaskImports(useFirstTaskGuideStore.getState().imports),
    ).toMatchObject([{ chatId: "chat-imported" }, { chatId: "chat-skipped" }]);
  });

  it("finishes imported continuation only for the same host and chat", () => {
    startRun(HOST_A, "run-a", "session-a");
    addOutcome(HOST_A, "run-a", "session-a", {
      kind: "imported",
      epicId: "epic-a",
      chatId: "chat-a",
    });
    useFirstTaskGuideStore.getState().rememberImport(HOST_A);
    useFirstTaskGuideStore.getState().activate();

    const guide = useFirstTaskGuideStore.getState();
    guide.messageSubmitted(HOST_B, "chat-a");
    guide.messageSubmitted(HOST_A, "other-chat");
    expect(useFirstTaskGuideStore.getState().status).toBe("active");

    useFirstTaskGuideStore.getState().messageSubmitted(HOST_A, "chat-a");
    expect(useFirstTaskGuideStore.getState().status).toBe("finished");
  });

  it("keeps dismissal finished and records workspace review", () => {
    const guide = useFirstTaskGuideStore.getState();
    guide.reviewWorkspace();
    guide.dismiss();

    expect(useFirstTaskGuideStore.getState().workspaceReviewed).toBe(true);
    useFirstTaskGuideStore
      .getState()
      .observeImports(useSessionImportRunStore.getState());
    useFirstTaskGuideStore.getState().messageSubmitted(HOST_A, "chat-a");
    expect(useFirstTaskGuideStore.getState().status).toBe("finished");
  });

  it("acknowledges each hint once and prepare clears acknowledgements", () => {
    const guide = useFirstTaskGuideStore.getState();
    guide.acknowledgeHint("folder");
    const acknowledged = useFirstTaskGuideStore.getState().acknowledgedHints;
    guide.acknowledgeHint("folder");

    expect(useFirstTaskGuideStore.getState().acknowledgedHints).toBe(
      acknowledged,
    );
    expect(acknowledged).toContain("folder");

    guide.prepare();
    expect(useFirstTaskGuideStore.getState().acknowledgedHints).toEqual(
      new Set(),
    );
  });
});
