import {
  STAGED_SANDBOX_STORAGE_KEY,
  persistedStageStorage,
  restoreStageStorage,
} from "@/lib/sandboxes/__tests__/staged-sandbox-storage-fixture";
import { recordMapStoragePrefix } from "@/lib/persist/keys";
import { requestPendingStageRetry } from "@/lib/sandboxes/pending-stage-storage";
import { pendingSend } from "@/lib/sandboxes/__tests__/pending-send-fixtures";
import {
  pendingSendSurfaceKey,
  usePendingSandboxSendStore,
} from "@/stores/sandboxes/pending-sandbox-send-store";
import { beforeEach, describe, expect, it } from "vitest";
import {
  readStagedSandbox,
  stagedSandboxRested,
  useStagedSandboxStore,
  type StagedSandboxTarget,
} from "@/stores/composer/staged-sandbox-store";

const SURFACE = "landing:window-1";

const NEW_TARGET: StagedSandboxTarget = {
  kind: "new",
  configuration: { kind: "team", teamId: "team-acme", teamName: "Acme" },
  shape: {
    os: "linux",
    cpus: 2,
    memoryMb: 4096,
    diskMb: null,
    region: "us-east",
    idleMinutes: 30,
    destroyAfterRestingMinutes: 10_080,
  },
  name: "",
  wakeString: "Resumes in about a second",
};

const EXISTING_TARGET: StagedSandboxTarget = {
  kind: "existing",
  hostId: "host-1",
  sandboxId: "sbx-1",
  name: "build-box",
  configuration: { kind: "personal" },
  verb: "resume",
};

beforeEach(() => {
  useStagedSandboxStore.setState({ bySurface: {} });
  localStorage.clear();
});

function stageOf(surfaceKey: string) {
  const stage = readStagedSandbox(surfaceKey);
  if (stage === null) throw new Error(`nothing staged for ${surfaceKey}`);
  return stage;
}

describe("staged sandbox store", () => {
  it("stages a pick per surface and clears it on another pick", () => {
    const store = useStagedSandboxStore.getState();
    store.stage(SURFACE, NEW_TARGET);
    store.stage("epic:e1", EXISTING_TARGET);

    expect(stageOf(SURFACE).target).toEqual(NEW_TARGET);
    expect(stageOf(SURFACE).phase).toBe("staged");
    expect(stageOf("epic:e1").target).toEqual(EXISTING_TARGET);

    store.clear(SURFACE);
    expect(readStagedSandbox(SURFACE)).toBeNull();
    expect(readStagedSandbox("epic:e1")).not.toBeNull();
  });

  it("assigns a new stage key on each pick", () => {
    const store = useStagedSandboxStore.getState();
    store.stage(SURFACE, NEW_TARGET);
    const first = stageOf(SURFACE).clientRequestId;

    store.stage(SURFACE, NEW_TARGET);

    expect(stageOf(SURFACE).clientRequestId).toMatch(/^stage:/);
    expect(stageOf(SURFACE).clientRequestId).not.toBe(first);
    expect(stageOf(SURFACE).phase).toBe("staged");
    expect(first).not.toBeNull();
  });

  it("assigns a clientRequestId at pick and retains it on repeated sends", () => {
    const store = useStagedSandboxStore.getState();
    store.stage(SURFACE, NEW_TARGET);
    const first = stageOf(SURFACE).clientRequestId;
    const repeat = store.begin(SURFACE, 1_000, {
      resume: false,
      createKey: null,
    });
    const again = store.begin(SURFACE, 2_000, {
      resume: false,
      createKey: null,
    });

    expect(first).not.toBeNull();
    expect(repeat).toBe(first);
    expect(again).toBe(first);
    expect(stageOf(SURFACE)).toMatchObject({
      phase: "creating",
      clientRequestId: first,
      startedAt: 2_000,
    });
  });

  it("keeps stage identity while Retry selects a failed row's key", () => {
    const store = useStagedSandboxStore.getState();
    store.stage(SURFACE, NEW_TARGET);
    const first = store.begin(SURFACE, 1_000, {
      resume: false,
      createKey: null,
    });
    store.report(SURFACE, {
      createdSandboxId: "sbx-9",
      createdHostId: "host-9",
      failure: {
        kind: "failed",
        code: "PROVIDER_CREATE_FAILED",
        step: "booting",
      },
    });

    const retried = store.begin(SURFACE, 3_000, {
      resume: false,
      createKey: "retry:sbx-9",
    });

    expect(retried).not.toBeNull();
    expect(retried).toBe(first);
    expect(stageOf(SURFACE)).toMatchObject({
      clientRequestId: first,
      lastCreateKey: "retry:sbx-9",
      createdSandboxId: null,
      createdHostId: null,
      failure: null,
    });
  });

  it("restages a terminally failed stage on Cancel with a fresh key, then first Send uses it", () => {
    const store = useStagedSandboxStore.getState();
    store.stage(SURFACE, NEW_TARGET);
    const oldKey = stageOf(SURFACE).clientRequestId;
    store.begin(SURFACE, 1_000, { resume: false, createKey: null });
    store.report(SURFACE, {
      ownerId: "draft-1",
      createdSandboxId: "sbx-9",
      createdHostId: "host-9",
      failure: { kind: "failed", code: "provider-failed", step: "booting" },
    });

    store.cancel(SURFACE, true);

    const restaged = stageOf(SURFACE);
    expect(restaged).toMatchObject({
      phase: "staged",
      target: NEW_TARGET,
      ownerId: "draft-1",
      createdSandboxId: null,
      createdHostId: null,
      failure: null,
    });
    expect(restaged.clientRequestId).not.toBe(oldKey);
    expect(restaged.clientRequestId).toMatch(/^stage:/);
    expect(restaged.clientRequestId?.length).toBeGreaterThanOrEqual(1);
    expect(restaged.clientRequestId?.length).toBeLessThanOrEqual(64);
    expect(
      store.begin(SURFACE, 2_000, { resume: false, createKey: null }),
    ).toBe(restaged.clientRequestId);
  });

  it("begins nothing when nothing is staged", () => {
    expect(
      useStagedSandboxStore
        .getState()
        .begin(SURFACE, 1, { resume: false, createKey: null }),
    ).toBeNull();
  });

  it("cancel returns to staged keeping the target, and the key of a create that may have been accepted", () => {
    const store = useStagedSandboxStore.getState();
    store.stage(SURFACE, NEW_TARGET);
    const id = store.begin(SURFACE, 1_000, {
      resume: false,
      createKey: null,
    });

    store.cancel(SURFACE, true);

    expect(stageOf(SURFACE)).toMatchObject({
      phase: "staged",
      clientRequestId: id,
      startedAt: 1_000,
      failure: null,
      target: NEW_TARGET,
    });
    expect(
      store.begin(SURFACE, 5_000, { resume: false, createKey: null }),
    ).toBe(id);
  });

  const FAILED = {
    kind: "failed",
    code: "PROVIDER_CREATE_FAILED",
    step: "booting",
  } as const;
  it.each([
    {
      failure: { kind: "unavailable" } as const,
      target: NEW_TARGET,
    },
    {
      failure: { kind: "credits", shortfallMc: 120 } as const,
      target: NEW_TARGET,
    },
    {
      failure: { kind: "unverified" } as const,
      target: NEW_TARGET,
    },
    // The sandbox that key made failed: naming it again answers with that row.
    { failure: FAILED, target: NEW_TARGET },
    // A wake has no create key to bill twice; the next one wakes again.
    { failure: FAILED, target: EXISTING_TARGET },
    {
      failure: { kind: "timed-out", step: "booting" } as const,
      target: NEW_TARGET,
    },
    {
      failure: { kind: "settings", code: "settings" } as const,
      target: NEW_TARGET,
    },
  ])(
    "cancel after a $failure.kind failure on a $target.kind target keeps the key",
    ({ failure, target }) => {
      const store = useStagedSandboxStore.getState();
      store.stage(SURFACE, target);
      const id = store.begin(SURFACE, 1_000, {
        resume: false,
        createKey: null,
      });
      store.report(SURFACE, { failure });

      store.cancel(SURFACE, true);

      expect(stageOf(SURFACE).clientRequestId).toBe(id);
    },
  );

  it("keeps the create key after a refusal even when the create was not accepted", () => {
    const store = useStagedSandboxStore.getState();
    store.stage(SURFACE, NEW_TARGET);
    const id = store.begin(SURFACE, 1_000, {
      resume: false,
      createKey: null,
    });
    // Accepted, then frozen for credits on its way up.
    store.report(SURFACE, {
      createdSandboxId: "sbx-9",
      failure: { kind: "credits", shortfallMc: null },
    });

    expect(stageOf(SURFACE).clientRequestId).toBe(id);
  });

  it("rejoin takes the stage back to creating with its step and times as they were", () => {
    const store = useStagedSandboxStore.getState();
    store.stage(SURFACE, NEW_TARGET);
    const id = store.begin(SURFACE, 1_000, {
      resume: false,
      createKey: null,
    });
    store.report(SURFACE, { step: "applying", stepAt: 4_000 });
    store.cancel(SURFACE, true);

    store.rejoin(SURFACE);

    expect(stageOf(SURFACE)).toMatchObject({
      phase: "creating",
      clientRequestId: id,
      step: "applying",
      stepAt: 4_000,
      startedAt: 1_000,
    });
  });

  it("persists only the stage of a send handed to its task, so a reload starts with nothing else staged", () => {
    const store = useStagedSandboxStore.getState();
    store.stage(SURFACE, NEW_TARGET);
    store.begin(SURFACE, 1_000, { resume: false, createKey: null });

    expect(persistedSurfaceKeys()).toEqual([]);

    store.stage(pendingSendSurfaceKey("send-1"), NEW_TARGET);
    expect(persistedSurfaceKeys()).toEqual([pendingSendSurfaceKey("send-1")]);
  });

  it("brings a handed-over stage back after a reload with its create key and the sandbox it made", async () => {
    const store = useStagedSandboxStore.getState();
    const key = pendingSendSurfaceKey("send-1");
    store.stage(key, NEW_TARGET);
    const clientRequestId = store.begin(key, 1_000, {
      resume: false,
      createKey: null,
    });
    store.report(key, {
      createdSandboxId: "sbx-1",
      createdHostId: "host-1",
      step: "booting",
      stepAt: 4_000,
    });
    const persisted = persistedStageStorage();

    useStagedSandboxStore.setState({ bySurface: {} });
    expect(readStagedSandbox(key)).toBeNull();
    restoreStageStorage(persisted);
    await useStagedSandboxStore.persist.rehydrate();

    expect(readStagedSandbox(key)).toMatchObject({
      phase: "creating",
      clientRequestId,
      createdSandboxId: "sbx-1",
      createdHostId: "host-1",
      step: "booting",
      startedAt: 1_000,
    });
  });

  it("restores a persisted stage key across reload and reuses it after a 402 refusal", async () => {
    const store = useStagedSandboxStore.getState();
    const key = pendingSendSurfaceKey("send-with-create-verdict");
    store.stage(key, NEW_TARGET);
    const first = store.begin(key, 1_000, { resume: false, createKey: null });
    store.report(key, { failure: { kind: "credits", shortfallMc: null } });
    const persisted = persistedStageStorage();

    useStagedSandboxStore.setState({ bySurface: {} });
    restoreStageStorage(persisted);
    await useStagedSandboxStore.persist.rehydrate();

    const restored = readStagedSandbox(key);
    if (restored === null)
      throw new Error("the pending stage was not restored");
    const retry = useStagedSandboxStore
      .getState()
      .begin(key, 5_000, { resume: false, createKey: first });

    expect(retry).toBe(first);
    expect(restored.clientRequestId).toBe(first);
  });

  it("moves a surface's stage to a pending send's key as it stands, key included", () => {
    const store = useStagedSandboxStore.getState();
    store.stage(SURFACE, NEW_TARGET);
    const clientRequestId = store.begin(SURFACE, 1_000, {
      resume: false,
      createKey: null,
    });
    const key = pendingSendSurfaceKey("send-1");

    store.adopt(SURFACE, key);

    expect(readStagedSandbox(SURFACE)).toBeNull();
    expect(readStagedSandbox(key)).toMatchObject({
      phase: "creating",
      clientRequestId,
    });
  });

  it("takes up a run a reload stopped with its step and times, while a send starts them again", () => {
    const store = useStagedSandboxStore.getState();
    store.stage(SURFACE, NEW_TARGET);
    store.begin(SURFACE, 1_000, { resume: false, createKey: null });
    store.report(SURFACE, { step: "booting", stepAt: 4_000 });

    store.begin(SURFACE, 9_000, { resume: true, createKey: null });
    expect(stageOf(SURFACE)).toMatchObject({
      step: "booting",
      stepAt: 4_000,
      startedAt: 1_000,
    });

    store.begin(SURFACE, 9_000, { resume: false, createKey: null });
    expect(stageOf(SURFACE)).toMatchObject({
      step: "creating",
      stepAt: 9_000,
      startedAt: 9_000,
    });
  });
});

/** The surfaces the store wrote to storage. */
function persistedSurfaceKeys(): string[] {
  const prefix = recordMapStoragePrefix(STAGED_SANDBOX_STORAGE_KEY);
  const keys: string[] = [];
  for (let index = 0; index < localStorage.length; index += 1) {
    const key = localStorage.key(index);
    if (
      key !== null &&
      key.startsWith(prefix) &&
      localStorage.getItem(key) !== "null"
    ) {
      keys.push(decodeURIComponent(key.slice(prefix.length)));
    }
  }
  return keys;
}

describe("a stage whose sandbox rested on its own", () => {
  function stageAt(
    step: "creating" | "booting" | "applying" | "delivering",
    phase: "creating" | "handoff",
  ) {
    const store = useStagedSandboxStore.getState();
    store.stage(SURFACE, NEW_TARGET);
    store.begin(SURFACE, 1_000, { resume: false, createKey: null });
    store.report(SURFACE, {
      createdSandboxId: "sbx-1",
      createdHostId: "host-1",
      step,
      phase,
    });
    return stageOf(SURFACE);
  }

  it.each([
    ["applying", "creating"],
    ["delivering", "creating"],
    ["creating", "handoff"],
  ] as const)("is rested at step %s in phase %s", (step, phase) => {
    expect(stagedSandboxRested(stageAt(step, phase), true)).toBe(true);
  });

  it.each([
    ["creating", "creating"],
    ["booting", "creating"],
  ] as const)("is not rested at step %s in phase %s", (step, phase) => {
    expect(stagedSandboxRested(stageAt(step, phase), true)).toBe(false);
  });

  it("is not rested while its row is not resting", () => {
    expect(stagedSandboxRested(stageAt("creating", "handoff"), false)).toBe(
      false,
    );
  });

  it("is rested for a recorded rest at step booting, only while its row rests", () => {
    stageAt("booting", "creating");
    useStagedSandboxStore.getState().report(SURFACE, {
      failure: { kind: "rested" },
    });
    expect(stagedSandboxRested(stageOf(SURFACE), true)).toBe(true);
    expect(stagedSandboxRested(stageOf(SURFACE), false)).toBe(false);
  });

  it("leaves a settings failure to its own line, even past handoff", () => {
    stageAt("creating", "handoff");
    useStagedSandboxStore.getState().report(SURFACE, {
      failure: { kind: "settings", code: "SBX-0520" },
    });
    expect(stagedSandboxRested(stageOf(SURFACE), true)).toBe(false);
  });
});

describe("a retry request written by a window that does not own the send", () => {
  it("survives the owner's stale progress write made before its window hydrates it", async () => {
    usePendingSandboxSendStore
      .getState()
      .add(pendingSend({ id: "mailbox-send", userId: "user-1" }));
    const surface = pendingSendSurfaceKey("mailbox-send");
    const store = useStagedSandboxStore.getState();
    store.stage(surface, NEW_TARGET);
    const clientRequestId = store.begin(surface, 1_000, {
      resume: false,
      createKey: null,
    });

    // Another window files its request; no storage event reaches this one.
    const requestId = requestPendingStageRetry({
      name: STAGED_SANDBOX_STORAGE_KEY,
      surfaceKey: surface,
      userId: "user-1",
      clientRequestId,
      sendId: "mailbox-send",
      action: "send-again",
      createKey: clientRequestId,
    });
    expect(requestId).not.toBeNull();
    expect(readStagedSandbox(surface)?.retryRequest).toBeUndefined();

    // The owner, still on its stale stage, writes progress.
    useStagedSandboxStore
      .getState()
      .report(surface, { step: "booting", stepAt: 2_000 });
    await useStagedSandboxStore.persist.rehydrate();

    expect(readStagedSandbox(surface)?.retryRequest).toMatchObject({
      id: requestId,
      userId: "user-1",
      createKey: clientRequestId,
    });
    expect(readStagedSandbox(surface)?.step).toBe("booting");
  });
});
