import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { persistKey } from "@/lib/persist";
import {
  useOnboardingFlowStore,
  INITIAL_FLOW,
  LEGACY_ONBOARDING_PERSIST_KEY,
  migrateLegacyOnboardingKey,
  selectOnboardingSettled,
  selectFirstRunModalDue,
  selectChainResumable,
  selectActiveStep,
  type OnboardingFlowData,
  type TourProgress,
  type AdvanceReason,
  type ModalStatus,
  type ChainStatus,
} from "@/stores/onboarding/onboarding-flow-store";
import {
  firstStepOf,
  type TourId,
} from "@/stores/onboarding/onboarding-tour-catalog";

// Hand-written, so a change to `PERSIST_PREFIX` or the store's leaf shows up
// as a failing assertion here rather than a silently different key.
const FLOW_KEY = "traycer-gui-app:onboarding-flow";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function data(): OnboardingFlowData {
  const state = useOnboardingFlowStore.getState();
  return {
    modal: state.modal,
    modalPage: state.modalPage,
    branch: state.branch,
    chain: state.chain,
    chainScope: state.chainScope,
    activeTourId: state.activeTourId,
    tours: state.tours,
    context: state.context,
    legacyCompleted: state.legacyCompleted,
    completionPending: state.completionPending,
  };
}

function tour(id: TourId): TourProgress {
  return useOnboardingFlowStore.getState().tours[id];
}

function advance(tourId: TourId, stepId: string, reason: AdvanceReason): void {
  useOnboardingFlowStore.getState().advance(tourId, stepId, reason);
}

class MapStorage {
  private readonly map = new Map<string, string>();

  getItem(key: string): string | null {
    const value = this.map.get(key);
    return value === undefined ? null : value;
  }

  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }

  removeItem(key: string): void {
    this.map.delete(key);
  }
}

describe("useOnboardingFlowStore", () => {
  beforeEach(() => {
    useOnboardingFlowStore.setState(INITIAL_FLOW);
    localStorage.clear();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(1_700_000_000_000);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("persistKey('onboarding-flow') matches the hand-written FLOW_KEY", () => {
    expect(persistKey("onboarding-flow")).toBe(FLOW_KEY);
  });

  it("persists under traycer-gui-app:onboarding-flow and only the data fields", () => {
    useOnboardingFlowStore.getState().startModal();

    const raw = localStorage.getItem(FLOW_KEY);
    if (raw === null) {
      throw new Error("Expected a persisted blob");
    }
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed) || !isRecord(parsed.state)) {
      throw new Error("Expected a zustand-persist envelope");
    }
    expect(parsed.version).toBe(1);
    expect(Object.keys(parsed.state).sort()).toEqual([
      "activeTourId",
      "branch",
      "chain",
      "chainScope",
      "completionPending",
      "context",
      "legacyCompleted",
      "modal",
      "modalPage",
      "tours",
    ]);
    expect(parsed.state.modal).toBe("in-progress");
  });

  it("finishModal and skipModal activate the branch's first tour", () => {
    useOnboardingFlowStore.getState().finishModal("no-sessions");
    expect(data().modal).toBe("done");
    expect(data().branch).toBe("no-sessions");
    expect(data().chain).toBe("active");
    expect(data().chainScope).toBe("branch");
    expect(data().activeTourId).toBe("add-folder");
    expect(tour("add-folder")).toEqual({
      status: "active",
      stepId: firstStepOf("add-folder"),
      completedAt: null,
    });
    expect(tour("terminal-mode").status).toBe("available");

    useOnboardingFlowStore.setState(INITIAL_FLOW);
    useOnboardingFlowStore.getState().finishModal("sessions");
    expect(data().activeTourId).toBe("history");
    expect(tour("history").status).toBe("active");
    expect(tour("history").stepId).toBe(firstStepOf("history"));

    useOnboardingFlowStore.setState(INITIAL_FLOW);
    useOnboardingFlowStore.getState().skipModal();
    expect(data().modal).toBe("skipped");
    expect(data().branch).toBe("no-sessions");
    expect(tour("add-folder").status).toBe("active");
  });

  it("advance is a no-op unless the chain is active on exactly that tour and step", () => {
    useOnboardingFlowStore.getState().finishModal("no-sessions");

    const before = useOnboardingFlowStore.getState();
    advance("terminal-mode", firstStepOf("terminal-mode"), "next"); // wrong tour
    expect(useOnboardingFlowStore.getState()).toBe(before);

    advance("add-folder", "nope", "next"); // wrong step
    expect(useOnboardingFlowStore.getState()).toBe(before);

    useOnboardingFlowStore.getState().pauseChain();
    const paused = useOnboardingFlowStore.getState();
    advance("add-folder", firstStepOf("add-folder"), "next"); // chain not active
    expect(useOnboardingFlowStore.getState()).toBe(paused);
  });

  it("advance walks the no-sessions branch to completion", () => {
    useOnboardingFlowStore.getState().finishModal("no-sessions");

    advance("add-folder", firstStepOf("add-folder"), "next");
    expect(data().activeTourId).toBe("terminal-mode");

    advance("terminal-mode", firstStepOf("terminal-mode"), "next");
    expect(data().activeTourId).toBe("submit-prompt");

    advance("submit-prompt", firstStepOf("submit-prompt"), "next");
    expect(data().activeTourId).toBe("task-panels");

    advance("task-panels", firstStepOf("task-panels"), "next");
    expect(data().chain).toBe("completed");
    expect(data().activeTourId).toBeNull();

    for (const tourId of [
      "add-folder",
      "terminal-mode",
      "submit-prompt",
      "task-panels",
    ] as const) {
      expect(tour(tourId)).toEqual({
        status: "done",
        stepId: null,
        completedAt: 1_700_000_000_000,
      });
    }
    expect(tour("history").status).toBe("available");
    expect(selectOnboardingSettled(data())).toBe(true);
  });

  describe("detour", () => {
    it("from terminal-mode, branch scope: bypasses submit-prompt and jumps to task-panels", () => {
      useOnboardingFlowStore.getState().finishModal("no-sessions");
      advance("add-folder", firstStepOf("add-folder"), "next");

      advance("terminal-mode", firstStepOf("terminal-mode"), "detour");

      expect(tour("terminal-mode")).toEqual({
        status: "done",
        stepId: null,
        completedAt: 1_700_000_000_000,
      });
      expect(tour("submit-prompt")).toEqual({
        status: "bypassed",
        stepId: null,
        completedAt: null,
      });
      expect(data().activeTourId).toBe("task-panels");
      expect(data().chain).toBe("active");
    });

    it("from submit-prompt: bypasses only itself and jumps to task-panels", () => {
      useOnboardingFlowStore.getState().finishModal("no-sessions");
      advance("add-folder", firstStepOf("add-folder"), "next");
      advance("terminal-mode", firstStepOf("terminal-mode"), "next");

      advance("submit-prompt", firstStepOf("submit-prompt"), "detour");

      expect(tour("submit-prompt")).toEqual({
        status: "bypassed",
        stepId: null,
        completedAt: null,
      });
      expect(data().activeTourId).toBe("task-panels");
    });

    it("from add-folder: detour is a no-op", () => {
      useOnboardingFlowStore.getState().finishModal("no-sessions");
      const before = useOnboardingFlowStore.getState();

      advance("add-folder", firstStepOf("add-folder"), "detour");

      expect(useOnboardingFlowStore.getState()).toBe(before);
    });

    it("single scope: detour finishes only that tour and completes the chain", () => {
      useOnboardingFlowStore.getState().finishModal("no-sessions");
      advance("add-folder", firstStepOf("add-folder"), "next");
      advance("terminal-mode", firstStepOf("terminal-mode"), "next");
      advance("submit-prompt", firstStepOf("submit-prompt"), "next");
      advance("task-panels", firstStepOf("task-panels"), "next");
      const submitPromptBeforeReplay = tour("submit-prompt");
      const taskPanelsBeforeReplay = tour("task-panels");

      useOnboardingFlowStore.getState().replayTour("terminal-mode");
      advance("terminal-mode", firstStepOf("terminal-mode"), "detour");

      expect(tour("terminal-mode")).toEqual({
        status: "done",
        stepId: null,
        completedAt: 1_700_000_000_000,
      });
      expect(data().chain).toBe("completed");
      expect(data().activeTourId).toBeNull();
      expect(tour("submit-prompt")).toEqual(submitPromptBeforeReplay);
      expect(tour("task-panels")).toEqual(taskPanelsBeforeReplay);
    });
  });

  it("pauseChain/resumeChain: resumable only while paused with an active tour, no-op otherwise", () => {
    useOnboardingFlowStore.getState().finishModal("no-sessions");

    useOnboardingFlowStore.getState().pauseChain();
    expect(data().chain).toBe("paused");
    expect(data().activeTourId).toBe("add-folder");
    expect(tour("add-folder").stepId).toBe(firstStepOf("add-folder"));
    expect(selectChainResumable(data())).toBe(true);

    useOnboardingFlowStore.getState().resumeChain();
    expect(data().chain).toBe("active");

    const activeState = useOnboardingFlowStore.getState();
    useOnboardingFlowStore.getState().resumeChain(); // already active
    expect(useOnboardingFlowStore.getState()).toBe(activeState);

    useOnboardingFlowStore.setState(INITIAL_FLOW); // pending, no active tour
    const pendingState = useOnboardingFlowStore.getState();
    useOnboardingFlowStore.getState().pauseChain();
    expect(useOnboardingFlowStore.getState()).toBe(pendingState);
  });

  it("skipChain releases the active tour; completeChain marks it done", () => {
    useOnboardingFlowStore.getState().finishModal("no-sessions");
    useOnboardingFlowStore.getState().skipChain();

    expect(data().chain).toBe("skipped");
    expect(data().activeTourId).toBeNull();
    expect(tour("add-folder")).toEqual({
      status: "available",
      stepId: null,
      completedAt: null,
    });

    useOnboardingFlowStore.setState(INITIAL_FLOW);
    useOnboardingFlowStore.getState().finishModal("no-sessions");
    useOnboardingFlowStore.getState().completeChain();

    expect(data().chain).toBe("completed");
    expect(tour("add-folder")).toEqual({
      status: "done",
      stepId: null,
      completedAt: 1_700_000_000_000,
    });
  });

  describe("replayTour", () => {
    it("replays a tour from a completed chain without re-activating a later one", () => {
      useOnboardingFlowStore.getState().finishModal("no-sessions");
      advance("add-folder", firstStepOf("add-folder"), "next");
      advance("terminal-mode", firstStepOf("terminal-mode"), "next");
      advance("submit-prompt", firstStepOf("submit-prompt"), "next");
      advance("task-panels", firstStepOf("task-panels"), "next");

      useOnboardingFlowStore.getState().replayTour("add-folder");
      expect(data().chain).toBe("active");
      expect(data().chainScope).toBe("single");
      expect(data().context).toBeNull();
      expect(data().activeTourId).toBe("add-folder");
      expect(tour("add-folder").status).toBe("active");
      expect(tour("add-folder").stepId).toBe(firstStepOf("add-folder"));
      expect(data().modal).toBe("done");

      advance("add-folder", firstStepOf("add-folder"), "next");
      expect(data().chain).toBe("completed");
      expect(tour("terminal-mode").status).toBe("done");
      expect(data().activeTourId).toBeNull();
    });

    it("replays a tour over the legacy-migrated shape and completes after that one tour", () => {
      useOnboardingFlowStore.setState({
        ...INITIAL_FLOW,
        modal: "done",
        chain: "skipped",
        chainScope: "single",
        legacyCompleted: true,
      });

      useOnboardingFlowStore.getState().replayTour("terminal-mode");
      advance("terminal-mode", firstStepOf("terminal-mode"), "next");

      expect(data().chain).toBe("completed");
    });

    it("releases the previously active tour back to available", () => {
      useOnboardingFlowStore.getState().finishModal("no-sessions");

      useOnboardingFlowStore.getState().replayTour("history");

      expect(tour("add-folder")).toEqual({
        status: "available",
        stepId: null,
        completedAt: null,
      });
      expect(data().activeTourId).toBe("history");
      expect(tour("history").status).toBe("active");
    });
  });

  it("activationRevision moves on every chain-level activation, including a same-tour replay with a null context, and stays put otherwise", () => {
    const revision = () => useOnboardingFlowStore.getState().activationRevision;
    const start = revision();
    useOnboardingFlowStore.getState().startModal();
    expect(revision()).toBe(start);
    useOnboardingFlowStore.getState().finishModal("no-sessions");
    expect(revision()).toBe(start + 1);
    useOnboardingFlowStore.getState().setContext({ draftId: "d" });
    useOnboardingFlowStore
      .getState()
      .advance("add-folder", "add-folder", "next");
    expect(revision()).toBe(start + 1);
    useOnboardingFlowStore.getState().pauseChain();
    useOnboardingFlowStore.getState().pauseChain();
    expect(revision()).toBe(start + 2);
    useOnboardingFlowStore.getState().resumeChain();
    expect(revision()).toBe(start + 3);
    // Replay: context resets - and replaying the SAME tour again while the
    // context is already null still counts (an unanchored lesson replayed).
    useOnboardingFlowStore.getState().replayTour("task-panels");
    expect(revision()).toBe(start + 4);
    expect(useOnboardingFlowStore.getState().context).toBeNull();
    useOnboardingFlowStore.getState().replayTour("task-panels");
    expect(revision()).toBe(start + 5);
    // A finishing advance is a chain end too.
    useOnboardingFlowStore
      .getState()
      .advance("task-panels", "task-panels", "next");
    expect(useOnboardingFlowStore.getState().chain).toBe("completed");
    expect(revision()).toBe(start + 6);
    useOnboardingFlowStore.getState().completeChain();
    expect(revision()).toBe(start + 6);
    // Not persisted.
    const raw = localStorage.getItem(FLOW_KEY);
    expect(raw).not.toBeNull();
    expect(raw).not.toContain("activationRevision");
  });

  it("completionPending is set by a real chain end (completed or skipped) and cleared by acknowledgeCompletion; never by the migration's shape", () => {
    const pending = () => useOnboardingFlowStore.getState().completionPending;
    expect(pending()).toBe(false);
    useOnboardingFlowStore.getState().skipChain();
    expect(pending()).toBe(false);
    useOnboardingFlowStore.getState().finishModal("sessions");
    useOnboardingFlowStore.getState().skipChain();
    expect(pending()).toBe(true);
    useOnboardingFlowStore.getState().acknowledgeCompletion();
    expect(pending()).toBe(false);
    useOnboardingFlowStore.getState().replayTour("history");
    useOnboardingFlowStore.getState().completeChain();
    expect(pending()).toBe(true);
    useOnboardingFlowStore.getState().acknowledgeCompletion();
    useOnboardingFlowStore.getState().replayTour("history");
    useOnboardingFlowStore.getState().pauseChain();
    expect(pending()).toBe(false);
    useOnboardingFlowStore.getState().completeChain();
    expect(pending()).toBe(true);
  });

  it("showWelcomeModalAgain reopens the modal without touching the chain or tours", () => {
    useOnboardingFlowStore.getState().finishModal("no-sessions");
    useOnboardingFlowStore.getState().pauseChain();

    useOnboardingFlowStore.getState().showWelcomeModalAgain();

    expect(data().modal).toBe("pending");
    expect(data().modalPage).toBe(1);
    expect(data().chain).toBe("paused");
    expect(data().branch).toBe("no-sessions");
    expect(tour("add-folder").status).toBe("active");
  });

  describe("merge validates per field", () => {
    it("repairs the active-tour invariant when the named tour is not active", async () => {
      localStorage.setItem(
        FLOW_KEY,
        JSON.stringify({
          version: 1,
          state: {
            modal: "bogus",
            modalPage: 2,
            branch: "sessions",
            chain: "active",
            chainScope: "single",
            activeTourId: "history",
            tours: {
              history: { status: "done", stepId: "nope", completedAt: 5 },
              bogus: { status: "active" },
              "add-folder": {
                status: "active",
                stepId: "add-folder",
                completedAt: "x",
              },
            },
            context: { draftId: "d1", epicId: 7 },
            legacyCompleted: "yes",
          },
        }),
      );

      await useOnboardingFlowStore.persist.rehydrate();

      const state = useOnboardingFlowStore.getState();
      expect(state.modal).toBe("pending");
      expect(state.modalPage).toBe(2);
      expect(state.branch).toBe("sessions");
      expect(state.chainScope).toBe("single");
      expect(state.tours.history).toEqual({
        status: "done",
        stepId: null,
        completedAt: 5,
      });
      expect("bogus" in state.tours).toBe(false);
      expect(state.tours["add-folder"]).toEqual({
        status: "active",
        stepId: "add-folder",
        completedAt: null,
      });
      expect(state.context).toEqual({
        draftId: "d1",
        epicId: null,
        tabId: null,
        hostId: null,
        attemptId: null,
      });
      expect(state.legacyCompleted).toBe(false);
      // history wasn't actually active, so the cross-field invariant is
      // repaired: the chain can't claim an active tour that isn't.
      expect(state.activeTourId).toBeNull();
      expect(state.chain).toBe("pending");
    });

    it("leaves activeTourId and chain alone when the named tour really is active", async () => {
      localStorage.setItem(
        FLOW_KEY,
        JSON.stringify({
          version: 1,
          state: {
            modal: "bogus",
            modalPage: 2,
            branch: "sessions",
            chain: "active",
            chainScope: "single",
            activeTourId: "add-folder",
            tours: {
              history: { status: "done", stepId: "nope", completedAt: 5 },
              bogus: { status: "active" },
              "add-folder": {
                status: "active",
                stepId: "add-folder",
                completedAt: "x",
              },
            },
            context: { draftId: "d1", epicId: 7 },
            legacyCompleted: "yes",
          },
        }),
      );

      await useOnboardingFlowStore.persist.rehydrate();

      const state = useOnboardingFlowStore.getState();
      expect(state.activeTourId).toBe("add-folder");
      expect(state.chain).toBe("active");
    });

    it("keeps a valid paused checkpoint exactly, and resumeChain picks it up", async () => {
      localStorage.setItem(
        FLOW_KEY,
        JSON.stringify({
          version: 1,
          state: {
            modal: "done",
            modalPage: 1,
            branch: "no-sessions",
            chain: "paused",
            chainScope: "branch",
            activeTourId: "terminal-mode",
            tours: {
              "add-folder": { status: "done", stepId: null, completedAt: 1 },
              "terminal-mode": {
                status: "active",
                stepId: "terminal-mode",
                completedAt: null,
              },
            },
            context: {
              draftId: "d1",
              epicId: "e1",
              tabId: "t1",
              hostId: "h1",
              attemptId: "a1",
            },
            legacyCompleted: false,
          },
        }),
      );

      await useOnboardingFlowStore.persist.rehydrate();

      const state = useOnboardingFlowStore.getState();
      expect(state.chain).toBe("paused");
      expect(state.activeTourId).toBe("terminal-mode");
      expect(tour("terminal-mode")).toEqual({
        status: "active",
        stepId: "terminal-mode",
        completedAt: null,
      });
      expect(state.context).toEqual({
        draftId: "d1",
        epicId: "e1",
        tabId: "t1",
        hostId: "h1",
        attemptId: "a1",
      });
      expect(selectChainResumable(data())).toBe(true);

      useOnboardingFlowStore.getState().resumeChain();
      expect(useOnboardingFlowStore.getState().chain).toBe("active");
      expect(selectActiveStep(data())).toEqual({
        tourId: "terminal-mode",
        stepId: "terminal-mode",
      });
    });

    // A running chain with no usable active id can neither advance nor
    // resume and never settles, so it is repaired to pending - whether the
    // id is missing or names a tour a later build retired.
    it.each([
      ["missing", undefined],
      ["unknown", "retired-tour"],
    ] as const)(
      "repairs a %s activeTourId on a running chain to pending",
      async (_label, activeTourId) => {
        for (const chain of ["active", "paused"] as const) {
          localStorage.setItem(
            FLOW_KEY,
            JSON.stringify({
              version: 1,
              state: {
                modal: "done",
                branch: "no-sessions",
                chain,
                activeTourId,
                tours: {
                  "add-folder": {
                    status: "active",
                    stepId: "add-folder",
                    completedAt: null,
                  },
                },
              },
            }),
          );

          await useOnboardingFlowStore.persist.rehydrate();

          const state = useOnboardingFlowStore.getState();
          expect(state.activeTourId, chain).toBeNull();
          expect(state.chain, chain).toBe("pending");
          // The tour rows themselves are not touched by the repair.
          expect(tour("add-folder").status).toBe("active");
        }
      },
    );

    it("leaves a settled chain with no activeTourId alone", async () => {
      localStorage.setItem(
        FLOW_KEY,
        JSON.stringify({
          version: 1,
          state: { modal: "done", chain: "completed", activeTourId: null },
        }),
      );

      await useOnboardingFlowStore.persist.rehydrate();

      const state = useOnboardingFlowStore.getState();
      expect(state.chain).toBe("completed");
      expect(state.activeTourId).toBeNull();
    });
  });

  describe("migrateLegacyOnboardingKey", () => {
    it("LEGACY_ONBOARDING_PERSIST_KEY is traycer-gui-app:onboarding", () => {
      expect(LEGACY_ONBOARDING_PERSIST_KEY).toBe("traycer-gui-app:onboarding");
    });

    it("seeds the new key from a valid legacy completedAt, and removes the legacy key", async () => {
      localStorage.setItem(
        LEGACY_ONBOARDING_PERSIST_KEY,
        JSON.stringify({ state: { completedAt: 123, step: 4 }, version: 1 }),
      );

      const result = migrateLegacyOnboardingKey(localStorage);

      expect(result).toBe("seeded");
      expect(localStorage.getItem(LEGACY_ONBOARDING_PERSIST_KEY)).toBeNull();

      const raw = localStorage.getItem(FLOW_KEY);
      if (raw === null) {
        throw new Error("Expected the new key to be seeded");
      }
      const parsed: unknown = JSON.parse(raw);
      if (!isRecord(parsed) || !isRecord(parsed.state)) {
        throw new Error("Expected a zustand-persist envelope");
      }
      expect(parsed.version).toBe(1);
      expect(parsed.state).toEqual({
        modal: "done",
        modalPage: 1,
        branch: null,
        chain: "skipped",
        chainScope: "single",
        activeTourId: null,
        tours: INITIAL_FLOW.tours,
        context: null,
        legacyCompleted: true,
        // The migration never announces a real end: no completion toast.
        completionPending: false,
      });

      await useOnboardingFlowStore.persist.rehydrate();
      expect(useOnboardingFlowStore.getState().legacyCompleted).toBe(true);
      expect(useOnboardingFlowStore.getState().modal).toBe("done");
      expect(useOnboardingFlowStore.getState().chain).toBe("skipped");
      expect(selectOnboardingSettled(data())).toBe(true);
      expect(selectFirstRunModalDue(data())).toBe(false);
    });

    it("drops a legacy record with a null completedAt, without seeding a new key", () => {
      localStorage.setItem(
        LEGACY_ONBOARDING_PERSIST_KEY,
        JSON.stringify({ state: { completedAt: null }, version: 1 }),
      );

      const result = migrateLegacyOnboardingKey(localStorage);

      expect(result).toBe("dropped");
      expect(localStorage.getItem(LEGACY_ONBOARDING_PERSIST_KEY)).toBeNull();
      expect(localStorage.getItem(FLOW_KEY)).toBeNull();
    });

    it("drops the legacy record when the new key already exists, leaving it untouched", () => {
      const existingNewKey = JSON.stringify({
        version: 1,
        state: { modal: "in-progress" },
      });
      localStorage.setItem(FLOW_KEY, existingNewKey);
      localStorage.setItem(
        LEGACY_ONBOARDING_PERSIST_KEY,
        JSON.stringify({ state: { completedAt: 123 }, version: 1 }),
      );

      const result = migrateLegacyOnboardingKey(localStorage);

      expect(result).toBe("dropped");
      expect(localStorage.getItem(FLOW_KEY)).toBe(existingNewKey);
      expect(localStorage.getItem(LEGACY_ONBOARDING_PERSIST_KEY)).toBeNull();
    });

    it("drops a malformed legacy blob", () => {
      localStorage.setItem(LEGACY_ONBOARDING_PERSIST_KEY, "{");

      const result = migrateLegacyOnboardingKey(localStorage);

      expect(result).toBe("dropped");
      expect(localStorage.getItem(LEGACY_ONBOARDING_PERSIST_KEY)).toBeNull();
      expect(localStorage.getItem(FLOW_KEY)).toBeNull();
    });

    it("does nothing when there is no legacy key", () => {
      const result = migrateLegacyOnboardingKey(localStorage);

      expect(result).toBe("none");
      expect(localStorage.getItem(FLOW_KEY)).toBeNull();
    });

    it("takes any Storage-like object, not just window.localStorage", () => {
      const stub = new MapStorage();
      stub.setItem(
        LEGACY_ONBOARDING_PERSIST_KEY,
        JSON.stringify({ state: { completedAt: 123, step: 4 }, version: 1 }),
      );

      const result = migrateLegacyOnboardingKey(stub);

      expect(result).toBe("seeded");
      expect(stub.getItem(LEGACY_ONBOARDING_PERSIST_KEY)).toBeNull();
      const raw = stub.getItem(FLOW_KEY);
      if (raw === null) {
        throw new Error("Expected the new key to be seeded");
      }
      const parsed: unknown = JSON.parse(raw);
      if (!isRecord(parsed) || !isRecord(parsed.state)) {
        throw new Error("Expected a zustand-persist envelope");
      }
      expect(parsed.version).toBe(1);
      expect(parsed.state).toEqual({
        modal: "done",
        modalPage: 1,
        branch: null,
        chain: "skipped",
        chainScope: "single",
        activeTourId: null,
        tours: INITIAL_FLOW.tours,
        context: null,
        legacyCompleted: true,
        // The migration never announces a real end: no completion toast.
        completionPending: false,
      });
    });
  });

  describe("selectors", () => {
    function flowWith(
      modal: ModalStatus,
      chain: ChainStatus,
    ): OnboardingFlowData {
      return { ...INITIAL_FLOW, modal, chain };
    }

    it.each([
      ["pending" as const, "pending" as const, false],
      ["done" as const, "active" as const, false],
      ["done" as const, "paused" as const, false],
      ["done" as const, "completed" as const, true],
      ["skipped" as const, "skipped" as const, true],
      ["in-progress" as const, "completed" as const, false],
    ])(
      "selectOnboardingSettled(modal: %s, chain: %s) is %s",
      (modal, chain, expected) => {
        expect(selectOnboardingSettled(flowWith(modal, chain))).toBe(expected);
      },
    );

    it.each([
      ["pending" as const, true],
      ["in-progress" as const, true],
      ["done" as const, false],
      ["skipped" as const, false],
    ])("selectFirstRunModalDue(modal: %s) is %s", (modal, expected) => {
      expect(selectFirstRunModalDue(flowWith(modal, "pending"))).toBe(expected);
    });

    it("selectActiveStep is null when no tour is active", () => {
      expect(selectActiveStep(INITIAL_FLOW)).toBeNull();
    });

    it("selectActiveStep falls back to the tour's first step when stepId is null", () => {
      useOnboardingFlowStore.setState({
        activeTourId: "add-folder",
        tours: {
          ...INITIAL_FLOW.tours,
          "add-folder": { status: "active", stepId: null, completedAt: null },
        },
      });

      expect(selectActiveStep(data())).toEqual({
        tourId: "add-folder",
        stepId: firstStepOf("add-folder"),
      });
    });

    it("selectActiveStep returns the stored stepId when set", () => {
      useOnboardingFlowStore.getState().finishModal("no-sessions");

      expect(selectActiveStep(data())).toEqual({
        tourId: "add-folder",
        stepId: firstStepOf("add-folder"),
      });
    });
  });
});
