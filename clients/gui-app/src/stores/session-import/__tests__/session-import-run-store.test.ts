import { beforeEach, describe, expect, it } from "vitest";
import type { GuiHarnessId } from "@traycer/protocol/host/index";
import type { SessionImportOutcome } from "@traycer/protocol/host/session-import/run";
import { sessionImportSelectionKey } from "@/components/session-import/session-import-model";
import {
  progressEntryFrom,
  sessionImportCountsFromOutcomes,
  sessionImportDoneCount,
  sessionImportIsRunning,
  sessionImportRunCounts,
  useSessionImportRunStore,
  type SessionImportProgressEntry,
} from "@/stores/session-import/session-import-run-store";

const IMPORTED: SessionImportOutcome = {
  kind: "imported",
  epicId: "epic-1",
  chatId: "chat-1",
};

const SKIPPED: SessionImportOutcome = {
  kind: "skipped_already_imported",
  epicId: "epic-2",
  chatId: "chat-2",
};

const FAILED: SessionImportOutcome = {
  kind: "failed",
  reason: "source_unreadable",
  detail: "boom",
};

/** The run every test folds into unless it is exercising a foreign frame. */
const RUN_ID = "run-1";

function entryForRun(
  runId: string,
  harness: GuiHarnessId,
  nativeSessionId: string,
  outcome: SessionImportOutcome,
): SessionImportProgressEntry {
  return progressEntryFrom({ runId, harness, nativeSessionId, outcome });
}

function entryFor(
  harness: GuiHarnessId,
  nativeSessionId: string,
  outcome: SessionImportOutcome,
): SessionImportProgressEntry {
  return entryForRun(RUN_ID, harness, nativeSessionId, outcome);
}

describe("useSessionImportRunStore", () => {
  beforeEach(() => {
    useSessionImportRunStore.getState().reset();
  });

  describe("idempotent folding", () => {
    it("applying the same progress entry twice leaves the done count at 1", () => {
      const titles = new Map([
        [sessionImportSelectionKey("claude", "s1"), "Session One"],
      ]);
      useSessionImportRunStore.getState().markStarting(titles);
      useSessionImportRunStore
        .getState()
        .applyStarted({ runId: "run-1", total: 2, attached: false });

      const entry = entryFor("claude", "s1", IMPORTED);
      useSessionImportRunStore.getState().applyProgress(entry);
      useSessionImportRunStore.getState().applyProgress(entry);

      const state = useSessionImportRunStore.getState();
      expect(sessionImportDoneCount(state)).toBe(1);
      expect(sessionImportCountsFromOutcomes(state.outcomes)).toEqual({
        imported: 1,
        skippedAlreadyImported: 0,
        failed: 0,
      });
    });

    it("a full replay of started + every progress frame leaves done/counts unchanged", () => {
      useSessionImportRunStore.getState().markStarting(new Map());
      useSessionImportRunStore
        .getState()
        .applyStarted({ runId: "run-1", total: 2, attached: false });

      const first = entryFor("claude", "s1", IMPORTED);
      const second = entryFor("codex", "s2", FAILED);
      useSessionImportRunStore.getState().applyProgress(first);
      useSessionImportRunStore.getState().applyProgress(second);

      const beforeReplay = useSessionImportRunStore.getState();
      expect(sessionImportDoneCount(beforeReplay)).toBe(2);

      // Re-subscribing replays `started` (same runId) plus every `progress`
      // frame already produced - see the run.ts module doc.
      useSessionImportRunStore
        .getState()
        .applyStarted({ runId: "run-1", total: 2, attached: false });
      useSessionImportRunStore.getState().applyProgress(first);
      useSessionImportRunStore.getState().applyProgress(second);

      const afterReplay = useSessionImportRunStore.getState();
      expect(sessionImportDoneCount(afterReplay)).toBe(2);
      expect(sessionImportCountsFromOutcomes(afterReplay.outcomes)).toEqual({
        imported: 1,
        skippedAlreadyImported: 0,
        failed: 1,
      });
    });

    it("applyStarted with a different runId discards the previous run's outcomes", () => {
      useSessionImportRunStore.getState().markStarting(new Map());
      useSessionImportRunStore
        .getState()
        .applyStarted({ runId: "run-1", total: 2, attached: false });
      useSessionImportRunStore
        .getState()
        .applyProgress(entryFor("claude", "s1", IMPORTED));

      expect(useSessionImportRunStore.getState().outcomes.size).toBe(1);

      useSessionImportRunStore
        .getState()
        .applyStarted({ runId: "run-2", total: 5, attached: false });

      const state = useSessionImportRunStore.getState();
      expect(state.runId).toBe("run-2");
      expect(state.total).toBe(5);
      expect(state.outcomes.size).toBe(0);
      expect(state.status).toBe("running");
    });
  });

  describe("counts", () => {
    it("sessionImportCountsFromOutcomes tallies a mixed set correctly", () => {
      const outcomes = new Map<string, SessionImportProgressEntry>();
      const entries = [
        entryFor("claude", "a", IMPORTED),
        entryFor("claude", "b", IMPORTED),
        entryFor("codex", "c", SKIPPED),
        entryFor("codex", "d", FAILED),
        entryFor("codex", "e", FAILED),
      ];
      for (const entry of entries) outcomes.set(entry.selectionKey, entry);

      expect(sessionImportCountsFromOutcomes(outcomes)).toEqual({
        imported: 2,
        skippedAlreadyImported: 1,
        failed: 2,
      });
    });

    it("prefers finalCounts once applyComplete has landed, even when it disagrees with the tallied outcomes", () => {
      useSessionImportRunStore.getState().markStarting(new Map());
      useSessionImportRunStore
        .getState()
        .applyStarted({ runId: "run-1", total: 1, attached: false });
      useSessionImportRunStore
        .getState()
        .applyProgress(entryFor("claude", "a", IMPORTED));

      const beforeComplete = useSessionImportRunStore.getState();
      expect(
        sessionImportRunCounts({
          outcomes: beforeComplete.outcomes,
          finalCounts: beforeComplete.finalCounts,
        }),
      ).toEqual({ imported: 1, skippedAlreadyImported: 0, failed: 0 });

      const disagreeingCounts = {
        imported: 0,
        skippedAlreadyImported: 0,
        failed: 9,
      };
      useSessionImportRunStore
        .getState()
        .applyComplete({ runId: "run-1", counts: disagreeingCounts });

      const afterComplete = useSessionImportRunStore.getState();
      expect(
        sessionImportRunCounts({
          outcomes: afterComplete.outcomes,
          finalCounts: afterComplete.finalCounts,
        }),
      ).toEqual(disagreeingCounts);
    });
  });

  describe("status transitions", () => {
    it("markStarting moves status to starting", () => {
      useSessionImportRunStore.getState().markStarting(new Map());
      expect(useSessionImportRunStore.getState().status).toBe("starting");
    });

    it("sessionImportIsRunning is true for starting/running and false otherwise", () => {
      expect(
        sessionImportIsRunning({
          ...useSessionImportRunStore.getState(),
          status: "starting",
        }),
      ).toBe(true);
      expect(
        sessionImportIsRunning({
          ...useSessionImportRunStore.getState(),
          status: "running",
        }),
      ).toBe(true);
      expect(
        sessionImportIsRunning({
          ...useSessionImportRunStore.getState(),
          status: "idle",
        }),
      ).toBe(false);
      expect(
        sessionImportIsRunning({
          ...useSessionImportRunStore.getState(),
          status: "complete",
        }),
      ).toBe(false);
      expect(
        sessionImportIsRunning({
          ...useSessionImportRunStore.getState(),
          status: "error",
        }),
      ).toBe(false);
    });

    it("applyProgress moves starting to running but does not un-finish a complete run", () => {
      useSessionImportRunStore.getState().markStarting(new Map());
      useSessionImportRunStore
        .getState()
        .applyStarted({ runId: "run-1", total: 1, attached: false });
      expect(useSessionImportRunStore.getState().status).toBe("running");

      useSessionImportRunStore
        .getState()
        .applyProgress(entryFor("claude", "a", IMPORTED));
      expect(useSessionImportRunStore.getState().status).toBe("running");

      useSessionImportRunStore.getState().applyComplete({
        runId: "run-1",
        counts: { imported: 1, skippedAlreadyImported: 0, failed: 0 },
      });
      expect(useSessionImportRunStore.getState().status).toBe("complete");

      // A late/replayed frame after completion must not un-finish the run.
      useSessionImportRunStore
        .getState()
        .applyProgress(entryFor("claude", "a", IMPORTED));
      expect(useSessionImportRunStore.getState().status).toBe("complete");
    });

    it("applyError is ignored when complete, ignored when idle, and takes effect while running", () => {
      // idle: reset() already leaves us at "idle".
      useSessionImportRunStore.getState().applyError();
      expect(useSessionImportRunStore.getState().status).toBe("idle");

      // running: takes effect.
      useSessionImportRunStore.getState().markStarting(new Map());
      useSessionImportRunStore
        .getState()
        .applyStarted({ runId: "run-1", total: 1, attached: false });
      useSessionImportRunStore.getState().applyError();
      expect(useSessionImportRunStore.getState().status).toBe("error");

      // complete: a drop after the summary is not an error.
      useSessionImportRunStore.getState().reset();
      useSessionImportRunStore.getState().markStarting(new Map());
      useSessionImportRunStore
        .getState()
        .applyStarted({ runId: "run-1", total: 1, attached: false });
      useSessionImportRunStore.getState().applyComplete({
        runId: "run-1",
        counts: { imported: 1, skippedAlreadyImported: 0, failed: 0 },
      });
      useSessionImportRunStore.getState().applyError();
      expect(useSessionImportRunStore.getState().status).toBe("complete");
    });
  });

  describe("titles / lastTitle", () => {
    it("markStarting stores the titles map, and applyProgress sets lastTitle by selection key", () => {
      const key = sessionImportSelectionKey("claude", "s1");
      const titles = new Map([[key, "My Session"]]);
      useSessionImportRunStore.getState().markStarting(titles);
      expect(useSessionImportRunStore.getState().titles).toEqual(titles);

      useSessionImportRunStore
        .getState()
        .applyStarted({ runId: "run-1", total: 1, attached: false });
      useSessionImportRunStore
        .getState()
        .applyProgress(entryFor("claude", "s1", IMPORTED));

      expect(useSessionImportRunStore.getState().lastTitle).toBe("My Session");
    });

    it("a progress entry whose key is not in titles leaves lastTitle at its previous value", () => {
      const knownKey = sessionImportSelectionKey("claude", "s1");
      const titles = new Map([[knownKey, "Known Session"]]);
      // The attach-mid-run case: the client has no submission of its own, so
      // markStarting is never called and titles stays empty via applyStarted
      // alone - simulate that by starting with titles present, then feeding a
      // progress frame for a session absent from the map.
      useSessionImportRunStore.getState().markStarting(titles);
      useSessionImportRunStore
        .getState()
        .applyStarted({ runId: "run-1", total: 2, attached: false });
      useSessionImportRunStore
        .getState()
        .applyProgress(entryFor("claude", "s1", IMPORTED));
      expect(useSessionImportRunStore.getState().lastTitle).toBe(
        "Known Session",
      );

      useSessionImportRunStore
        .getState()
        .applyProgress(entryFor("codex", "unknown-session", SKIPPED));

      expect(useSessionImportRunStore.getState().lastTitle).toBe(
        "Known Session",
      );
    });
  });

  describe("attaching to a run already in flight", () => {
    it("keeps `attached` and drops the titles this window submitted", () => {
      const key = sessionImportSelectionKey("claude", "s1");
      useSessionImportRunStore
        .getState()
        .markStarting(new Map([[key, "My Session"]]));

      useSessionImportRunStore
        .getState()
        .applyStarted({ runId: "someone-elses-run", total: 4, attached: true });

      const state = useSessionImportRunStore.getState();
      expect(state.attached).toBe(true);
      expect(state.titles.size).toBe(0);
      // Our selections were never started, so a frame from the running import
      // must not be captioned with one of our session titles.
      useSessionImportRunStore
        .getState()
        .applyProgress(
          entryForRun("someone-elses-run", "claude", "s1", IMPORTED),
        );
      expect(useSessionImportRunStore.getState().lastTitle).toBeNull();
    });

    it("a redeclared start for the run we are tracking keeps the titles and stays ours", () => {
      const key = sessionImportSelectionKey("claude", "s1");
      const titles = new Map([[key, "My Session"]]);
      useSessionImportRunStore.getState().markStarting(titles);
      useSessionImportRunStore
        .getState()
        .applyStarted({ runId: RUN_ID, total: 2, attached: false });
      useSessionImportRunStore
        .getState()
        .applyProgress(entryFor("claude", "s1", IMPORTED));

      // A physical reconnect resubscribes, and the host answers `attached:
      // true` for the run this window submitted - which is a reattach, not
      // somebody else's import.
      useSessionImportRunStore
        .getState()
        .applyStarted({ runId: RUN_ID, total: 2, attached: true });

      const state = useSessionImportRunStore.getState();
      expect(state.attached).toBe(false);
      expect(state.titles).toEqual(titles);
      expect(state.outcomes.size).toBe(1);
      expect(state.lastTitle).toBe("My Session");
    });

    it("a start for a different run discards this run's outcomes and titles", () => {
      const key = sessionImportSelectionKey("claude", "s1");
      useSessionImportRunStore
        .getState()
        .markStarting(new Map([[key, "My Session"]]));
      useSessionImportRunStore
        .getState()
        .applyStarted({ runId: RUN_ID, total: 2, attached: false });
      useSessionImportRunStore
        .getState()
        .applyProgress(entryFor("claude", "s1", IMPORTED));

      useSessionImportRunStore
        .getState()
        .applyStarted({ runId: "someone-elses-run", total: 4, attached: true });

      const state = useSessionImportRunStore.getState();
      expect(state.runId).toBe("someone-elses-run");
      expect(state.attached).toBe(true);
      expect(state.titles.size).toBe(0);
      expect(state.outcomes.size).toBe(0);
    });

    it("a normal start keeps the titles and leaves `attached` false", () => {
      const key = sessionImportSelectionKey("claude", "s1");
      const titles = new Map([[key, "My Session"]]);
      useSessionImportRunStore.getState().markStarting(titles);
      useSessionImportRunStore
        .getState()
        .applyStarted({ runId: RUN_ID, total: 1, attached: false });

      const state = useSessionImportRunStore.getState();
      expect(state.attached).toBe(false);
      expect(state.titles).toEqual(titles);
    });

    it("reset clears `attached`", () => {
      useSessionImportRunStore.getState().markStarting(new Map());
      useSessionImportRunStore
        .getState()
        .applyStarted({ runId: RUN_ID, total: 1, attached: true });
      expect(useSessionImportRunStore.getState().attached).toBe(true);

      useSessionImportRunStore.getState().reset();
      expect(useSessionImportRunStore.getState().attached).toBe(false);
    });
  });

  describe("frames from another run", () => {
    it("a progress frame carrying another runId is ignored", () => {
      useSessionImportRunStore.getState().markStarting(new Map());
      useSessionImportRunStore
        .getState()
        .applyStarted({ runId: RUN_ID, total: 2, attached: false });
      useSessionImportRunStore
        .getState()
        .applyProgress(entryFor("claude", "s1", IMPORTED));

      useSessionImportRunStore
        .getState()
        .applyProgress(entryForRun("run-other", "codex", "s2", FAILED));

      const state = useSessionImportRunStore.getState();
      expect(state.outcomes.size).toBe(1);
      expect(sessionImportCountsFromOutcomes(state.outcomes)).toEqual({
        imported: 1,
        skippedAlreadyImported: 0,
        failed: 0,
      });
    });

    it("a complete frame carrying another runId leaves the run running", () => {
      useSessionImportRunStore.getState().markStarting(new Map());
      useSessionImportRunStore
        .getState()
        .applyStarted({ runId: RUN_ID, total: 2, attached: false });

      useSessionImportRunStore.getState().applyComplete({
        runId: "run-other",
        counts: { imported: 9, skippedAlreadyImported: 0, failed: 0 },
      });

      const state = useSessionImportRunStore.getState();
      expect(state.status).toBe("running");
      expect(state.runId).toBe(RUN_ID);
      expect(state.finalCounts).toBeNull();
    });

    it("a progress frame arriving after reset does not revive the run", () => {
      useSessionImportRunStore.getState().markStarting(new Map());
      useSessionImportRunStore
        .getState()
        .applyStarted({ runId: RUN_ID, total: 2, attached: false });
      useSessionImportRunStore.getState().reset();

      useSessionImportRunStore
        .getState()
        .applyProgress(entryFor("claude", "s1", IMPORTED));

      const state = useSessionImportRunStore.getState();
      expect(state.status).toBe("idle");
      expect(state.outcomes.size).toBe(0);
      expect(state.runId).toBeNull();
    });
  });

  describe("progressEntryFrom", () => {
    it("derives selectionKey exactly as sessionImportSelectionKey does, and carries the frame's runId", () => {
      const entry = progressEntryFrom({
        runId: RUN_ID,
        harness: "claude",
        nativeSessionId: "native-42",
        outcome: IMPORTED,
      });
      expect(entry.selectionKey).toBe(
        sessionImportSelectionKey("claude", "native-42"),
      );
      expect(entry.runId).toBe(RUN_ID);
    });
  });
});
