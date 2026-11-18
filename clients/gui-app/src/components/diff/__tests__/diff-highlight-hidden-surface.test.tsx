import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import type { FileDiffMetadata } from "@pierre/diffs";
import type { WorkerPoolManager, WorkerStats } from "@pierre/diffs/worker";
import {
  useDiffsDiffEditHighlightReady,
  useDiffsDiffHighlightReady,
} from "@/components/diff/use-diff-highlight-ready";
import {
  __resetDiffWorkerPoolForTests,
  getDiffWorkerPool,
  registerDiffWorkerPoolCreator,
} from "@/lib/diff/diff-worker-pool-demand";
import { PaneVisibilityContext } from "@/components/epic-tabs/pane-visibility-context";
import { TabBodySelectedContext } from "@/components/epic-canvas/canvas/tab-body-selected-context";
import {
  DESKTOP_RETENTION_PROFILE,
  MOBILE_RETENTION_PROFILE,
  setRetentionProfile,
} from "@/stores/replica-memory/retention-profile";

/**
 * `useWorkerPool()` wired to the demand store exactly as
 * `DiffWorkerPoolProvider` wires it, rather than to a hand-set fixture the way
 * `use-diff-highlight-ready.test.tsx` does. These tests are about the loop
 * between the two - a hidden surface gives its lease back, the idle window
 * terminates the workers, and the context must NOT carry any of that back into
 * the gate - so a context that cannot change would assert nothing.
 */
vi.mock("@pierre/diffs/react", async () => {
  const { useSyncExternalStore } = await import("react");
  const { getDiffWorkerPool: read, subscribeDiffWorkerPool: subscribe } =
    await import("@/lib/diff/diff-worker-pool-demand");
  return {
    useWorkerPool: () => useSyncExternalStore(subscribe, read, read),
  };
});

const IDLE_MS = MOBILE_RETENTION_PROFILE.diffWorkerPoolIdleMs;

interface FakeWorkerPoolManager {
  readonly setRenderOptions: () => Promise<void>;
  readonly primeFileHighlightCache: () => Promise<void>;
  readonly primeDiffHighlightCache: Mock<
    (fileDiff: FileDiffMetadata) => Promise<void>
  >;
  readonly getStats: () => WorkerStats;
  readonly subscribeToStatChanges: () => () => void;
  readonly terminate: Mock<() => void>;
}

interface SpyCreator {
  readonly creator: Mock<() => WorkerPoolManager>;
  readonly managers: ReadonlyArray<FakeWorkerPoolManager>;
  /** While raised, every prime hangs until {@link SpyCreator.flushPrimes}. */
  readonly holdPrimes: { current: boolean };
  readonly flushPrimes: () => void;
  readonly only: () => FakeWorkerPoolManager;
}

/**
 * A creator whose every manager is assertable. Each manager is a
 * prototype-less object asserted to the ~90-member class, the same seam the
 * sibling gate suite uses - `as unknown as` is lint-forbidden here and a
 * handful of members does not overlap enough for a direct `as`. Its stats
 * report a live, idle pool until `terminate` runs.
 */
function spyCreator(): SpyCreator {
  const managers: Array<FakeWorkerPoolManager> = [];
  const holdPrimes = { current: false };
  const heldPrimes: Array<() => void> = [];
  const creator = vi.fn<() => WorkerPoolManager>(() => {
    let totalWorkers = 1;
    const fake: FakeWorkerPoolManager = {
      setRenderOptions: () => Promise.resolve(),
      primeFileHighlightCache: () => Promise.resolve(),
      primeDiffHighlightCache: vi.fn((_fileDiff: FileDiffMetadata) => {
        if (!holdPrimes.current) return Promise.resolve();
        return new Promise<void>((resolve) => heldPrimes.push(resolve));
      }),
      getStats: () => ({
        managerState: totalWorkers === 0 ? "waiting" : "initialized",
        workersFailed: false,
        totalWorkers,
        busyWorkers: 0,
        queuedTasks: 0,
        activeTasks: 0,
        themeSubscribers: 0,
        fileCacheSize: 0,
        diffCacheSize: 0,
      }),
      subscribeToStatChanges: () => () => {},
      terminate: vi.fn(() => {
        totalWorkers = 0;
      }),
    };
    managers.push(fake);
    return Object.assign(Object.create(null) as WorkerPoolManager, fake);
  });
  return {
    creator,
    managers,
    holdPrimes,
    flushPrimes: () => {
      for (const resolve of heldPrimes.splice(0)) resolve();
    },
    only: () => {
      if (managers.length !== 1) {
        throw new Error(`expected one manager, built ${managers.length}`);
      }
      return managers[0];
    },
  };
}

function sampleDiff(name: string): FileDiffMetadata {
  const diff: Partial<FileDiffMetadata> = { name };
  return Object.assign(Object.create(null) as FileDiffMetadata, diff);
}

const FILE_DIFFS: ReadonlyArray<FileDiffMetadata> = [sampleDiff("a.ts")];
const REFETCHED_FILE_DIFFS: ReadonlyArray<FileDiffMetadata> = [
  sampleDiff("a.ts"),
];

/**
 * The two gates `DiffContentPrimitive` mounts side by side, and the branch it
 * takes between them: a closed read gate renders the loader INSTEAD of the
 * `<FileDiff>`.
 */
function DiffBody(props: {
  readonly editing: boolean;
  readonly fileDiffs: ReadonlyArray<FileDiffMetadata>;
}) {
  const ready = useDiffsDiffHighlightReady({
    fileDiffs: props.fileDiffs,
    theme: "pierre-dark",
    enabled: !props.editing,
  });
  const editReady = useDiffsDiffEditHighlightReady({
    fileDiffs: props.fileDiffs,
    theme: "pierre-dark",
    enabled: props.editing,
  });
  if (!ready) return <div data-testid="body">loader</div>;
  return (
    <div data-testid="body">
      {props.editing && editReady ? "editor" : "diff"}
    </div>
  );
}

function DiffSurface(props: {
  readonly visible: boolean;
  readonly selected: boolean;
  readonly editing: boolean;
  readonly fileDiffs: ReadonlyArray<FileDiffMetadata>;
}) {
  return (
    <PaneVisibilityContext.Provider value={props.visible}>
      <TabBodySelectedContext.Provider value={props.selected}>
        <DiffBody editing={props.editing} fileDiffs={props.fileDiffs} />
      </TabBodySelectedContext.Provider>
    </PaneVisibilityContext.Provider>
  );
}

function body(container: HTMLElement): string {
  const node = container.querySelector("[data-testid='body']");
  if (node === null) throw new Error("no body rendered");
  return node.textContent;
}

describe("diff highlight gates on a hidden surface", () => {
  beforeEach(() => {
    __resetDiffWorkerPoolForTests();
    vi.useFakeTimers();
    setRetentionProfile(MOBILE_RETENTION_PROFILE);
  });

  afterEach(() => {
    cleanup();
    __resetDiffWorkerPoolForTests();
    setRetentionProfile(DESKTOP_RETENTION_PROFILE);
    vi.useRealTimers();
  });

  it("keeps the body when the surface is hidden, and the idle window takes only the workers", async () => {
    const spy = spyCreator();
    registerDiffWorkerPoolCreator(spy.creator);

    const rendered = render(
      <DiffSurface visible selected editing={false} fileDiffs={FILE_DIFFS} />,
    );
    await act(async () => {});
    expect(body(rendered.container)).toBe("diff");
    const manager = getDiffWorkerPool();

    // The phone keeps this surface MOUNTED behind the one the user navigated
    // to (`retainedTopLevelSurfaces`), so nothing unmounts here - only the
    // pane's visibility flips.
    rendered.rerender(
      <DiffSurface
        visible={false}
        selected
        editing={false}
        fileDiffs={FILE_DIFFS}
      />,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(IDLE_MS);
    });

    expect(spy.only().terminate).toHaveBeenCalledTimes(1);
    expect(body(rendered.container)).toBe("diff");
    expect(getDiffWorkerPool()).toBe(manager);
  });

  it("re-shows the same body with no new pool and no new prime after the window ran", async () => {
    const spy = spyCreator();
    registerDiffWorkerPoolCreator(spy.creator);

    const rendered = render(
      <DiffSurface visible selected editing={false} fileDiffs={FILE_DIFFS} />,
    );
    await act(async () => {});
    rendered.rerender(
      <DiffSurface
        visible={false}
        selected
        editing={false}
        fileDiffs={FILE_DIFFS}
      />,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(IDLE_MS);
    });
    expect(spy.only().terminate).toHaveBeenCalledTimes(1);
    spy.only().primeDiffHighlightCache.mockClear();

    // Any prime from here on hangs, so a gate that re-armed would be stuck on
    // its loader. The body already holds its highlighted result; the workers
    // it lost are only needed for the NEXT thing it has to highlight.
    spy.holdPrimes.current = true;
    rendered.rerender(
      <DiffSurface visible selected editing={false} fileDiffs={FILE_DIFFS} />,
    );
    await act(async () => {});

    expect(body(rendered.container)).toBe("diff");
    expect(spy.creator).toHaveBeenCalledTimes(1);
    expect(spy.only().primeDiffHighlightCache).not.toHaveBeenCalled();
  });

  it("never terminates while a visible diff is mounted", async () => {
    const spy = spyCreator();
    registerDiffWorkerPoolCreator(spy.creator);

    const rendered = render(
      <DiffSurface visible selected editing={false} fileDiffs={FILE_DIFFS} />,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(IDLE_MS * 20);
    });

    expect(spy.only().terminate).not.toHaveBeenCalled();
    expect(body(rendered.container)).toBe("diff");
  });

  it("keeps a hidden editor mounted through the window", async () => {
    const spy = spyCreator();
    registerDiffWorkerPoolCreator(spy.creator);

    const rendered = render(
      <DiffSurface visible selected editing fileDiffs={FILE_DIFFS} />,
    );
    await act(async () => {});
    expect(body(rendered.container)).toBe("editor");

    rendered.rerender(
      <DiffSurface visible={false} selected editing fileDiffs={FILE_DIFFS} />,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(IDLE_MS);
    });

    // Whatever has been typed lives in the mounted editor instance, which
    // highlights on the main thread during an edit session. The workers can
    // go; the editor must not.
    expect(spy.only().terminate).toHaveBeenCalledTimes(1);
    expect(body(rendered.container)).toBe("editor");
  });

  it("counts an unselected tab body as hidden, not only an unshown pane", async () => {
    const spy = spyCreator();
    registerDiffWorkerPoolCreator(spy.creator);

    const rendered = render(
      <DiffSurface visible selected editing={false} fileDiffs={FILE_DIFFS} />,
    );
    await act(async () => {});

    rendered.rerender(
      <DiffSurface
        visible
        selected={false}
        editing={false}
        fileDiffs={FILE_DIFFS}
      />,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(IDLE_MS);
    });

    expect(spy.only().terminate).toHaveBeenCalledTimes(1);
    expect(body(rendered.container)).toBe("diff");
  });

  it("does not prime for a hidden surface", async () => {
    const spy = spyCreator();
    registerDiffWorkerPoolCreator(spy.creator);

    const rendered = render(
      <DiffSurface visible selected editing={false} fileDiffs={FILE_DIFFS} />,
    );
    await act(async () => {});
    spy.only().primeDiffHighlightCache.mockClear();

    rendered.rerender(
      <DiffSurface
        visible={false}
        selected
        editing={false}
        fileDiffs={FILE_DIFFS}
      />,
    );
    await act(async () => {});
    // A background refetch hands the hidden gate a fresh model. A prime is a
    // task, and a task is what brings released isolates back for a surface no
    // one is looking at.
    rendered.rerender(
      <DiffSurface
        visible={false}
        selected
        editing={false}
        fileDiffs={REFETCHED_FILE_DIFFS}
      />,
    );
    await act(async () => {});

    expect(spy.only().primeDiffHighlightCache).not.toHaveBeenCalled();
    expect(body(rendered.container)).toBe("diff");
  });

  it("holds a surface first mounted hidden on its loader, without a lease, until it is shown", async () => {
    const spy = spyCreator();
    registerDiffWorkerPoolCreator(spy.creator);

    const rendered = render(
      <DiffSurface
        visible={false}
        selected
        editing={false}
        fileDiffs={FILE_DIFFS}
      />,
    );
    await act(async () => {});
    expect(spy.creator).not.toHaveBeenCalled();
    expect(body(rendered.container)).toBe("loader");

    rendered.rerender(
      <DiffSurface visible selected editing={false} fileDiffs={FILE_DIFFS} />,
    );
    await act(async () => {});

    expect(spy.creator).toHaveBeenCalledTimes(1);
    expect(body(rendered.container)).toBe("diff");
  });

  it("gives desktop the same release, on its five-minute window", async () => {
    setRetentionProfile(DESKTOP_RETENTION_PROFILE);
    const spy = spyCreator();
    registerDiffWorkerPoolCreator(spy.creator);

    const rendered = render(
      <DiffSurface visible selected editing={false} fileDiffs={FILE_DIFFS} />,
    );
    await act(async () => {});
    rendered.rerender(
      <DiffSurface
        visible={false}
        selected
        editing={false}
        fileDiffs={FILE_DIFFS}
      />,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(
        DESKTOP_RETENTION_PROFILE.diffWorkerPoolIdleMs - 1,
      );
    });
    expect(spy.only().terminate).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });

    expect(spy.only().terminate).toHaveBeenCalledTimes(1);
    expect(body(rendered.container)).toBe("diff");
  });
});
