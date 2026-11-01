import { persistKey, STORE_KEYS } from "@/lib/persist";
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
  stagedCreateNeedsFreshKey,
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

  it("restaging replaces the stage and drops the old idempotency key", () => {
    const store = useStagedSandboxStore.getState();
    store.stage(SURFACE, NEW_TARGET);
    const first = store.begin(SURFACE, false, 1_000, false);

    store.stage(SURFACE, NEW_TARGET);

    expect(stageOf(SURFACE).clientRequestId).toBeNull();
    expect(stageOf(SURFACE).phase).toBe("staged");
    expect(first).not.toBeNull();
  });

  it("mints one clientRequestId at the first send and returns the same one on a repeat", () => {
    const store = useStagedSandboxStore.getState();
    store.stage(SURFACE, NEW_TARGET);
    expect(stageOf(SURFACE).clientRequestId).toBeNull();

    const first = store.begin(SURFACE, false, 1_000, false);
    const repeat = store.begin(SURFACE, false, 2_000, false);

    expect(first).not.toBeNull();
    expect(repeat).toBe(first);
    expect(stageOf(SURFACE)).toMatchObject({
      phase: "creating",
      clientRequestId: first,
      startedAt: 2_000,
    });
  });

  it("mints a new id for Retry creation and forgets the sandbox the old one made", () => {
    const store = useStagedSandboxStore.getState();
    store.stage(SURFACE, NEW_TARGET);
    const first = store.begin(SURFACE, false, 1_000, false);
    store.report(SURFACE, {
      createdSandboxId: "sbx-9",
      createdHostId: "host-9",
      failure: {
        kind: "failed",
        code: "PROVIDER_CREATE_FAILED",
        step: "booting",
      },
    });

    const retried = store.begin(SURFACE, true, 3_000, false);

    expect(retried).not.toBeNull();
    expect(retried).not.toBe(first);
    expect(stageOf(SURFACE)).toMatchObject({
      clientRequestId: retried,
      createdSandboxId: null,
      createdHostId: null,
      failure: null,
    });
  });

  it("begins nothing when nothing is staged", () => {
    expect(
      useStagedSandboxStore.getState().begin(SURFACE, false, 1, false),
    ).toBeNull();
  });

  it("cancel returns to staged keeping the target, and the key of a create that may have been accepted", () => {
    const store = useStagedSandboxStore.getState();
    store.stage(SURFACE, NEW_TARGET);
    const id = store.begin(SURFACE, false, 1_000, false);

    store.cancel(SURFACE);

    expect(stageOf(SURFACE)).toMatchObject({
      phase: "staged",
      clientRequestId: id,
      startedAt: 1_000,
      failure: null,
      target: NEW_TARGET,
    });
    expect(stagedCreateNeedsFreshKey(stageOf(SURFACE))).toBe(false);
    expect(store.begin(SURFACE, false, 5_000, false)).toBe(id);
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
      keeps: false,
    },
    {
      failure: { kind: "credits", shortfallMc: 120 } as const,
      target: NEW_TARGET,
      keeps: false,
    },
    {
      failure: { kind: "unverified" } as const,
      target: NEW_TARGET,
      keeps: true,
    },
    // The sandbox that key made failed: naming it again answers with that row.
    { failure: FAILED, target: NEW_TARGET, keeps: false },
    // A wake has no create key to bill twice; the next one wakes again.
    { failure: FAILED, target: EXISTING_TARGET, keeps: true },
    {
      failure: { kind: "timed-out", step: "booting" } as const,
      target: NEW_TARGET,
      keeps: true,
    },
    {
      failure: { kind: "settings", code: "settings" } as const,
      target: NEW_TARGET,
      keeps: true,
    },
  ])(
    "cancel after a $failure.kind failure on a $target.kind target keeps the key: $keeps",
    ({ failure, target, keeps }) => {
      const store = useStagedSandboxStore.getState();
      store.stage(SURFACE, target);
      const id = store.begin(SURFACE, false, 1_000, false);
      store.report(SURFACE, { failure });

      expect(stagedCreateNeedsFreshKey(stageOf(SURFACE))).toBe(!keeps);
      store.cancel(SURFACE);

      expect(stageOf(SURFACE).clientRequestId).toBe(keeps ? id : null);
    },
  );

  it("needs a fresh key after a refusal only while no sandbox was accepted", () => {
    const store = useStagedSandboxStore.getState();
    store.stage(SURFACE, NEW_TARGET);
    store.begin(SURFACE, false, 1_000, false);
    // Accepted, then frozen for credits on its way up.
    store.report(SURFACE, {
      createdSandboxId: "sbx-9",
      failure: { kind: "credits", shortfallMc: null },
    });

    expect(stagedCreateNeedsFreshKey(stageOf(SURFACE))).toBe(false);
  });

  it("rejoin takes the stage back to creating with its step and times as they were", () => {
    const store = useStagedSandboxStore.getState();
    store.stage(SURFACE, NEW_TARGET);
    const id = store.begin(SURFACE, false, 1_000, false);
    store.report(SURFACE, { step: "applying", stepAt: 4_000 });
    store.cancel(SURFACE);

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
    store.begin(SURFACE, false, 1_000, false);

    expect(persistedSurfaceKeys()).toEqual([]);

    store.stage(pendingSendSurfaceKey("send-1"), NEW_TARGET);
    expect(persistedSurfaceKeys()).toEqual([pendingSendSurfaceKey("send-1")]);
  });

  it("brings a handed-over stage back after a reload with its create key and the sandbox it made", async () => {
    const store = useStagedSandboxStore.getState();
    const key = pendingSendSurfaceKey("send-1");
    store.stage(key, NEW_TARGET);
    const clientRequestId = store.begin(key, false, 1_000, false);
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

  it("moves a surface's stage to a pending send's key as it stands, key included", () => {
    const store = useStagedSandboxStore.getState();
    store.stage(SURFACE, NEW_TARGET);
    const clientRequestId = store.begin(SURFACE, false, 1_000, false);
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
    store.begin(SURFACE, false, 1_000, false);
    store.report(SURFACE, { step: "booting", stepAt: 4_000 });

    store.begin(SURFACE, false, 9_000, true);
    expect(stageOf(SURFACE)).toMatchObject({
      step: "booting",
      stepAt: 4_000,
      startedAt: 1_000,
    });

    store.begin(SURFACE, false, 9_000, false);
    expect(stageOf(SURFACE)).toMatchObject({
      step: "creating",
      stepAt: 9_000,
      startedAt: 9_000,
    });
  });
});

const STAGE_STORAGE_KEY = persistKey(STORE_KEYS.stagedSandboxSend);

/** The surfaces the store wrote to storage. */
function persistedSurfaceKeys(): string[] {
  const prefix = recordMapStoragePrefix(STAGE_STORAGE_KEY);
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

function persistedStageStorage(): ReadonlyArray<readonly [string, string]> {
  const prefix = recordMapStoragePrefix(STAGE_STORAGE_KEY);
  const entries: Array<readonly [string, string]> = [];
  for (let index = 0; index < localStorage.length; index += 1) {
    const key = localStorage.key(index);
    if (
      key === null ||
      (key !== STAGE_STORAGE_KEY && !key.startsWith(prefix))
    ) {
      continue;
    }
    const value = localStorage.getItem(key);
    if (value !== null) entries.push([key, value]);
  }
  return entries;
}

function restoreStageStorage(
  entries: ReadonlyArray<readonly [string, string]>,
): void {
  const prefix = recordMapStoragePrefix(STAGE_STORAGE_KEY);
  const keys: string[] = [];
  for (let index = 0; index < localStorage.length; index += 1) {
    const key = localStorage.key(index);
    if (key === STAGE_STORAGE_KEY || (key !== null && key.startsWith(prefix))) {
      keys.push(key);
    }
  }
  for (const key of keys) localStorage.removeItem(key);
  for (const [key, value] of entries) localStorage.setItem(key, value);
}

describe("a stage whose sandbox rested on its own", () => {
  function stageAt(
    step: "creating" | "booting" | "applying" | "delivering",
    phase: "creating" | "handoff",
  ) {
    const store = useStagedSandboxStore.getState();
    store.stage(SURFACE, NEW_TARGET);
    store.begin(SURFACE, false, 1_000, false);
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
    const clientRequestId = store.begin(surface, false, 1_000, false);

    // Another window files its request; no storage event reaches this one.
    const requestId = requestPendingStageRetry({
      name: persistKey(STORE_KEYS.stagedSandboxSend),
      surfaceKey: surface,
      userId: "user-1",
      clientRequestId,
      sendId: "mailbox-send",
      action: "send-again",
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
    });
    expect(readStagedSandbox(surface)?.step).toBe("booting");
  });
});
