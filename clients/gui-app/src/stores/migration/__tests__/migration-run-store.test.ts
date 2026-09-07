import { beforeEach, describe, expect, it } from "vitest";
import {
  migrationAnyRunning,
  migrationModalRun,
  migrationRunFor,
  useMigrationRunStore,
  type MigrationRunCounts,
} from "@/stores/migration/migration-run-store";

const HOST_A = "host-a";
const HOST_B = "host-b";

const ZERO_COUNTS: MigrationRunCounts = {
  taskChainsComplete: 0,
  taskChainsSkipped: 0,
  taskChainsFailed: 0,
  epicsComplete: 0,
  epicsFailed: 0,
  replaysIncomplete: 0,
};

describe("useMigrationRunStore", () => {
  beforeEach(() => {
    useMigrationRunStore.setState({ runs: new Map(), remoteRunning: false });
  });

  describe("per-host folding", () => {
    it("keeps two hosts running at once with separate totals and counts", () => {
      useMigrationRunStore.getState().markRunning(HOST_A);
      useMigrationRunStore.getState().applyStarted(HOST_A, {
        totalTaskChains: 10,
        totalLocalEpics: 4,
      });
      useMigrationRunStore.getState().markRunning(HOST_B);
      useMigrationRunStore.getState().applyStarted(HOST_B, {
        totalTaskChains: 2,
        totalLocalEpics: 1,
      });

      useMigrationRunStore.getState().incrementTaskChain(HOST_A, "complete");
      useMigrationRunStore.getState().incrementTaskChain(HOST_A, "complete");
      useMigrationRunStore.getState().incrementTaskChain(HOST_A, "failed");
      useMigrationRunStore.getState().incrementEpic(HOST_A, "complete");
      useMigrationRunStore.getState().incrementTaskChain(HOST_B, "skipped");

      const state = useMigrationRunStore.getState();
      const runA = migrationRunFor(state, HOST_A);
      const runB = migrationRunFor(state, HOST_B);

      expect(runA.totals).toEqual({ totalTaskChains: 10, totalLocalEpics: 4 });
      expect(runA.counts).toEqual({
        ...ZERO_COUNTS,
        taskChainsComplete: 2,
        taskChainsFailed: 1,
        epicsComplete: 1,
      });

      expect(runB.totals).toEqual({ totalTaskChains: 2, totalLocalEpics: 1 });
      expect(runB.counts).toEqual({
        ...ZERO_COUNTS,
        taskChainsSkipped: 1,
      });

      // Neither host's slice leaked into the other's.
      expect(runA.status).toBe("running");
      expect(runB.status).toBe("running");
    });

    it("incrementReplayIncomplete and applyComplete fold only the named host", () => {
      useMigrationRunStore.getState().markRunning(HOST_A);
      useMigrationRunStore.getState().markRunning(HOST_B);
      useMigrationRunStore.getState().incrementReplayIncomplete(HOST_A);

      let state = useMigrationRunStore.getState();
      expect(migrationRunFor(state, HOST_A).counts.replaysIncomplete).toBe(1);
      expect(migrationRunFor(state, HOST_B).counts.replaysIncomplete).toBe(0);

      useMigrationRunStore.getState().applyComplete(HOST_A, {
        success: true,
        counts: { ...ZERO_COUNTS, taskChainsComplete: 5 },
      });

      state = useMigrationRunStore.getState();
      expect(migrationRunFor(state, HOST_A).status).toBe("complete");
      expect(migrationRunFor(state, HOST_A).finalSuccess).toBe(true);
      // host-b never got an applyComplete - still running with its own counts.
      expect(migrationRunFor(state, HOST_B).status).toBe("running");
    });
  });

  describe("migrationAnyRunning", () => {
    it("is false with no hosts, true while any host is running, false once every host settles", () => {
      expect(migrationAnyRunning(useMigrationRunStore.getState().runs)).toBe(
        false,
      );

      useMigrationRunStore.getState().markRunning(HOST_A);
      expect(migrationAnyRunning(useMigrationRunStore.getState().runs)).toBe(
        true,
      );

      useMigrationRunStore.getState().markRunning(HOST_B);
      useMigrationRunStore.getState().applyComplete(HOST_A, {
        success: true,
        counts: ZERO_COUNTS,
      });
      // host-b is still running.
      expect(migrationAnyRunning(useMigrationRunStore.getState().runs)).toBe(
        true,
      );

      useMigrationRunStore.getState().applyComplete(HOST_B, {
        success: true,
        counts: ZERO_COUNTS,
      });
      expect(migrationAnyRunning(useMigrationRunStore.getState().runs)).toBe(
        false,
      );
    });
  });

  describe("migrationModalRun", () => {
    it("prefers a running host over an errored one, whichever order they were inserted", () => {
      useMigrationRunStore.getState().markRunning(HOST_A);
      useMigrationRunStore.getState().applyError(HOST_A);
      expect(
        migrationRunFor(useMigrationRunStore.getState(), HOST_A).status,
      ).toBe("error");

      useMigrationRunStore.getState().markRunning(HOST_B);

      const entry = migrationModalRun(useMigrationRunStore.getState().runs);
      expect(entry).not.toBeNull();
      expect(entry?.hostId).toBe(HOST_B);
      expect(entry?.run.status).toBe("running");
    });

    it("falls back to an errored host when nothing is running, and null when nothing needs the modal", () => {
      expect(
        migrationModalRun(useMigrationRunStore.getState().runs),
      ).toBeNull();

      useMigrationRunStore.getState().markRunning(HOST_A);
      useMigrationRunStore.getState().applyError(HOST_A);

      const entry = migrationModalRun(useMigrationRunStore.getState().runs);
      expect(entry?.hostId).toBe(HOST_A);
      expect(entry?.run.status).toBe("error");

      useMigrationRunStore.getState().reset(HOST_A);
      expect(
        migrationModalRun(useMigrationRunStore.getState().runs),
      ).toBeNull();
    });
  });

  describe("reset", () => {
    it("retires only the named host's run, leaving every other host untouched", () => {
      useMigrationRunStore.getState().markRunning(HOST_A);
      useMigrationRunStore.getState().markRunning(HOST_B);
      useMigrationRunStore.getState().incrementTaskChain(HOST_B, "complete");

      useMigrationRunStore.getState().reset(HOST_A);

      const state = useMigrationRunStore.getState();
      expect(migrationRunFor(state, HOST_A).status).toBe("idle");
      expect(migrationRunFor(state, HOST_B).status).toBe("running");
      expect(migrationRunFor(state, HOST_B).counts.taskChainsComplete).toBe(1);
    });
  });

  describe("remoteRunning", () => {
    it("stays a single top-level bit, unaffected by per-host runs and their resets", () => {
      expect(useMigrationRunStore.getState().remoteRunning).toBe(false);

      useMigrationRunStore.getState().setRemoteRunning(true);
      useMigrationRunStore.getState().markRunning(HOST_A);
      useMigrationRunStore.getState().reset(HOST_A);

      // Neither starting nor retiring a host's run touches the flag - it is
      // driven only by the cross-window IPC snapshot via `setRemoteRunning`.
      expect(useMigrationRunStore.getState().remoteRunning).toBe(true);

      useMigrationRunStore.getState().setRemoteRunning(false);
      expect(useMigrationRunStore.getState().remoteRunning).toBe(false);
    });
  });
});
