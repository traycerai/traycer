import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  isArtifactUnread,
  useArtifactReadStateStore,
} from "@/stores/epics/artifact-read-state-store";

const EMPTY_SEED: Readonly<Record<string, number>> = {};
const EMPTY_LAST_SEEN: Readonly<
  Record<string, Readonly<Record<string, number>>>
> = {};

function unread(args: {
  epicId: string;
  artifactId: string;
  updatedAt: number;
}): boolean {
  const state = useArtifactReadStateStore.getState();
  return isArtifactUnread({
    epicId: args.epicId,
    artifactId: args.artifactId,
    updatedAt: args.updatedAt,
    seedAtByEpic: state.seedAtByEpic,
    lastSeenByArtifact: state.lastSeenByArtifact,
  });
}

describe("artifact-read-state-store", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    localStorage.clear();
    useArtifactReadStateStore.setState({
      seedAtByEpic: {},
      lastSeenByArtifact: {},
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("seeds current artifact versions as read for the session baseline", () => {
    useArtifactReadStateStore
      .getState()
      .seedEpicArtifacts("epic-a", [{ id: "artifact-a", updatedAt: 2_000 }]);

    expect(
      unread({ epicId: "epic-a", artifactId: "artifact-a", updatedAt: 2_000 }),
    ).toBe(false);
  });

  it("suppresses every marker until the epic baseline is seeded", () => {
    expect(
      isArtifactUnread({
        epicId: "epic-a",
        artifactId: "artifact-a",
        updatedAt: 5_000,
        seedAtByEpic: EMPTY_SEED,
        lastSeenByArtifact: EMPTY_LAST_SEEN,
      }),
    ).toBe(false);
  });

  it("treats an artifact created after the baseline as unread, ignoring wall clocks", () => {
    useArtifactReadStateStore
      .getState()
      .seedEpicArtifacts("epic-a", [{ id: "artifact-a", updatedAt: 900 }]);
    // A later snapshot tick must not re-seed (the epic is already baselined).
    useArtifactReadStateStore
      .getState()
      .seedEpicArtifacts("epic-a", [{ id: "artifact-b", updatedAt: 1_100 }]);

    // artifact-b never entered the baseline -> unread, even though its updatedAt
    // (1_100) and even a stale-clock value (500, below the 1_000 seed time) sit
    // at/under the seed wall-clock. No timestamp comparison can hide it.
    expect(
      unread({ epicId: "epic-a", artifactId: "artifact-b", updatedAt: 1_100 }),
    ).toBe(true);
    expect(
      unread({ epicId: "epic-a", artifactId: "artifact-c", updatedAt: 500 }),
    ).toBe(true);
  });

  it("re-marks a seeded artifact unread once a newer version arrives", () => {
    useArtifactReadStateStore
      .getState()
      .seedEpicArtifacts("epic-a", [{ id: "artifact-a", updatedAt: 1_000 }]);

    expect(
      unread({ epicId: "epic-a", artifactId: "artifact-a", updatedAt: 1_000 }),
    ).toBe(false);
    expect(
      unread({ epicId: "epic-a", artifactId: "artifact-a", updatedAt: 1_500 }),
    ).toBe(true);
  });

  it("clears unread by advancing the artifact's last-seen version on markRead", () => {
    useArtifactReadStateStore
      .getState()
      .seedEpicArtifacts("epic-a", [{ id: "artifact-a", updatedAt: 1_000 }]);
    expect(
      unread({ epicId: "epic-a", artifactId: "artifact-a", updatedAt: 2_000 }),
    ).toBe(true);

    useArtifactReadStateStore
      .getState()
      .markRead("epic-a", "artifact-a", 2_000);

    expect(
      unread({ epicId: "epic-a", artifactId: "artifact-a", updatedAt: 2_000 }),
    ).toBe(false);
  });

  it("markRead is an exact no-op for an already-seen or older version", () => {
    useArtifactReadStateStore
      .getState()
      .seedEpicArtifacts("epic-a", [{ id: "artifact-a", updatedAt: 1_000 }]);
    useArtifactReadStateStore
      .getState()
      .markRead("epic-a", "artifact-a", 2_000);

    const before = useArtifactReadStateStore.getState().lastSeenByArtifact;
    useArtifactReadStateStore
      .getState()
      .markRead("epic-a", "artifact-a", 1_500);
    const after = useArtifactReadStateStore.getState().lastSeenByArtifact;

    // No watermark rollback and no spurious store mutation (same reference).
    expect(after).toBe(before);
    expect(
      unread({ epicId: "epic-a", artifactId: "artifact-a", updatedAt: 2_000 }),
    ).toBe(false);
  });

  it("markRead does not disturb sibling artifacts", () => {
    useArtifactReadStateStore.getState().seedEpicArtifacts("epic-a", [
      { id: "artifact-a", updatedAt: 1_000 },
      { id: "artifact-b", updatedAt: 1_000 },
    ]);

    useArtifactReadStateStore
      .getState()
      .markRead("epic-a", "artifact-a", 3_000);

    // Sibling b keeps its own baseline: a newer version of b is still unread.
    expect(
      unread({ epicId: "epic-a", artifactId: "artifact-b", updatedAt: 2_000 }),
    ).toBe(true);
  });

  it("does not re-seed an epic whose baseline already exists", () => {
    useArtifactReadStateStore
      .getState()
      .seedEpicArtifacts("epic-a", [{ id: "artifact-a", updatedAt: 1_000 }]);
    const seededAt =
      useArtifactReadStateStore.getState().seedAtByEpic["epic-a"];

    vi.setSystemTime(9_999);
    useArtifactReadStateStore
      .getState()
      .seedEpicArtifacts("epic-a", [{ id: "artifact-a", updatedAt: 4_000 }]);
    const state = useArtifactReadStateStore.getState();

    // Baseline marker is unchanged and the original seeded version is preserved.
    expect(state.seedAtByEpic["epic-a"]).toBe(seededAt);
    expect(
      unread({ epicId: "epic-a", artifactId: "artifact-a", updatedAt: 1_000 }),
    ).toBe(false);
    expect(
      unread({ epicId: "epic-a", artifactId: "artifact-a", updatedAt: 4_000 }),
    ).toBe(true);
  });
});
