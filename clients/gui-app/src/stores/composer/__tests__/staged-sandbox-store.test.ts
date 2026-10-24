import { beforeEach, describe, expect, it } from "vitest";
import {
  readStagedSandbox,
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
    const first = store.begin(SURFACE, false, 1_000);

    store.stage(SURFACE, NEW_TARGET);

    expect(stageOf(SURFACE).clientRequestId).toBeNull();
    expect(stageOf(SURFACE).phase).toBe("staged");
    expect(first).not.toBeNull();
  });

  it("mints one clientRequestId at the first send and returns the same one on a repeat", () => {
    const store = useStagedSandboxStore.getState();
    store.stage(SURFACE, NEW_TARGET);
    expect(stageOf(SURFACE).clientRequestId).toBeNull();

    const first = store.begin(SURFACE, false, 1_000);
    const repeat = store.begin(SURFACE, false, 2_000);

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
    const first = store.begin(SURFACE, false, 1_000);
    store.report(SURFACE, {
      createdSandboxId: "sbx-9",
      createdHostId: "host-9",
      failure: {
        kind: "failed",
        code: "PROVIDER_CREATE_FAILED",
        step: "booting",
      },
    });

    const retried = store.begin(SURFACE, true, 3_000);

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
      useStagedSandboxStore.getState().begin(SURFACE, false, 1),
    ).toBeNull();
  });

  it("cancel returns to staged keeping the target", () => {
    const store = useStagedSandboxStore.getState();
    store.stage(SURFACE, NEW_TARGET);
    const id = store.begin(SURFACE, false, 1_000);
    store.report(SURFACE, { failure: { kind: "unavailable" } });

    store.cancel(SURFACE);

    expect(stageOf(SURFACE)).toMatchObject({
      phase: "staged",
      clientRequestId: id,
      startedAt: null,
      failure: null,
      target: NEW_TARGET,
    });
    expect(store.begin(SURFACE, false, 5_000)).toBe(id);
  });

  it("keeps a stage in memory only, so a reload starts with nothing staged", () => {
    const store = useStagedSandboxStore.getState();
    store.stage(SURFACE, NEW_TARGET);
    store.begin(SURFACE, false, 1_000);

    expect(localStorage.length).toBe(0);
  });
});
