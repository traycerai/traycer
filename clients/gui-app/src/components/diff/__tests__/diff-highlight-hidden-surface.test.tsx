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
import type { WorkerPoolManager } from "@pierre/diffs/worker";
import {
  useDiffsDiffEditHighlightReady,
  useDiffsDiffHighlightReady,
} from "@/components/diff/use-diff-highlight-ready";
import {
  __resetDiffWorkerPoolForTests,
  getDiffWorkerPool,
  registerDiffWorkerPoolLifecycle,
  type DiffWorkerPoolLifecycle,
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
 * between the two - a hidden surface drops its Diffs body, the lease goes with
 * it, the idle window terminates the pool, and the context has to carry that
 * disappearance back into the gate - so a context that cannot go away would
 * assert nothing.
 */
vi.mock("@pierre/diffs/react", async () => {
  const { useSyncExternalStore } = await import("react");
  const { getDiffWorkerPool: read, subscribeDiffWorkerPool: subscribe } =
    await import("@/lib/diff/diff-worker-pool-demand");
  return {
    useWorkerPool: () => useSyncExternalStore(subscribe, read, read),
  };
});

const IDLE_MS = MOBILE_RETENTION_PROFILE.diffWorkerPoolIdleMs ?? 0;

interface FakeWorkerPoolManager {
  readonly setRenderOptions: () => Promise<void>;
  readonly primeFileHighlightCache: () => Promise<void>;
  readonly primeDiffHighlightCache: Mock<
    (fileDiff: FileDiffMetadata) => Promise<void>
  >;
}

interface SpyLifecycle {
  readonly lifecycle: DiffWorkerPoolLifecycle;
  readonly create: Mock<() => WorkerPoolManager>;
  readonly terminate: Mock<() => void>;
  readonly managers: ReadonlyArray<FakeWorkerPoolManager>;
  /** While raised, every prime hangs until {@link SpyLifecycle.flushPrimes}. */
  readonly holdPrimes: { current: boolean };
  readonly flushPrimes: () => void;
}

/**
 * A lifecycle whose `create`/`terminate` are both assertable, handing out a
 * fresh manager per build (the identity of the SECOND one is what proves a
 * re-shown surface highlights against a new pool rather than a corpse).
 *
 * Each manager is a prototype-less object asserted to the ~90-member class,
 * the same seam the sibling gate suite uses - `as unknown as` is lint-
 * forbidden here and a four-member literal does not overlap enough for a
 * direct `as`.
 */
function spyLifecycle(): SpyLifecycle {
  const managers: Array<FakeWorkerPoolManager> = [];
  const holdPrimes = { current: false };
  const heldPrimes: Array<() => void> = [];
  const create = vi.fn<() => WorkerPoolManager>(() => {
    const fake: FakeWorkerPoolManager = {
      setRenderOptions: () => Promise.resolve(),
      primeFileHighlightCache: () => Promise.resolve(),
      primeDiffHighlightCache: vi.fn((_fileDiff: FileDiffMetadata) => {
        if (!holdPrimes.current) return Promise.resolve();
        return new Promise<void>((resolve) => heldPrimes.push(resolve));
      }),
    };
    managers.push(fake);
    return Object.assign(Object.create(null) as WorkerPoolManager, fake);
  });
  const terminate = vi.fn<() => void>(() => {});
  return {
    lifecycle: { create, terminate },
    create,
    terminate,
    managers,
    holdPrimes,
    flushPrimes: () => {
      for (const resolve of heldPrimes.splice(0)) resolve();
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
 * `<FileDiff>`, which is how a concealed surface stops holding the pool.
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
  return node.textContent ?? "";
}

describe("diff highlight gates on a hidden surface", () => {
  beforeEach(() => {
    __resetDiffWorkerPoolForTests();
    vi.useFakeTimers();
  });

  afterEach(() => {
    cleanup();
    __resetDiffWorkerPoolForTests();
    setRetentionProfile(DESKTOP_RETENTION_PROFILE);
    vi.useRealTimers();
  });

  it("drops the body and the lease when the surface is hidden, and the idle window then takes the pool", async () => {
    setRetentionProfile(MOBILE_RETENTION_PROFILE);
    const spy = spyLifecycle();
    registerDiffWorkerPoolLifecycle(spy.lifecycle);

    const rendered = render(
      <DiffSurface visible selected editing={false} fileDiffs={FILE_DIFFS} />,
    );
    await act(async () => {});
    expect(spy.create).toHaveBeenCalledTimes(1);
    expect(body(rendered.container)).toBe("diff");

    // The phone keeps this surface MOUNTED behind the one the user navigated
    // to (`retainedTopLevelSurfaces`), so nothing unmounts here - only the
    // pane's visibility flips. That is the edge the device runs found the idle
    // window never got.
    rendered.rerender(
      <DiffSurface
        visible={false}
        selected
        editing={false}
        fileDiffs={FILE_DIFFS}
      />,
    );
    await act(async () => {});
    expect(body(rendered.container)).toBe("loader");
    expect(spy.terminate).not.toHaveBeenCalled();

    await act(async () => {
      vi.advanceTimersByTime(IDLE_MS);
    });

    expect(spy.terminate).toHaveBeenCalledTimes(1);
    expect(getDiffWorkerPool()).toBeUndefined();
  });

  it("takes a NEW pool and holds the loader for its prime when the surface is shown again", async () => {
    setRetentionProfile(MOBILE_RETENTION_PROFILE);
    const spy = spyLifecycle();
    registerDiffWorkerPoolLifecycle(spy.lifecycle);

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
      vi.advanceTimersByTime(IDLE_MS);
    });
    expect(getDiffWorkerPool()).toBeUndefined();

    spy.holdPrimes.current = true;
    rendered.rerender(
      <DiffSurface visible selected editing={false} fileDiffs={FILE_DIFFS} />,
    );
    await act(async () => {});

    expect(spy.create).toHaveBeenCalledTimes(2);
    const rebuilt = spy.managers[1];
    if (rebuilt === undefined) throw new Error("no rebuilt manager");
    expect(getDiffWorkerPool()).toBeDefined();
    expect(rebuilt.primeDiffHighlightCache).toHaveBeenCalledWith(FILE_DIFFS[0]);
    // The rebuilt isolates are cold and the terminated manager's caches went
    // with it, so the gate re-arms: showing a body here would render an empty
    // diff until the library's own `initialize().then(rerender)` landed.
    expect(body(rendered.container)).toBe("loader");

    await act(async () => {
      spy.flushPrimes();
    });
    expect(body(rendered.container)).toBe("diff");
  });

  it("re-shows in one frame when the conceal was shorter than the idle window", async () => {
    setRetentionProfile(MOBILE_RETENTION_PROFILE);
    const spy = spyLifecycle();
    registerDiffWorkerPoolLifecycle(spy.lifecycle);

    const rendered = render(
      <DiffSurface visible selected editing={false} fileDiffs={FILE_DIFFS} />,
    );
    await act(async () => {});
    const manager = getDiffWorkerPool();

    rendered.rerender(
      <DiffSurface
        visible={false}
        selected
        editing={false}
        fileDiffs={FILE_DIFFS}
      />,
    );
    await act(async () => {
      vi.advanceTimersByTime(IDLE_MS / 2);
    });
    expect(body(rendered.container)).toBe("loader");

    // Any prime from here on hangs - so a gate that re-armed would be stuck on
    // its loader. It must not: the pool survived, its diff cache with it, and
    // the body it kept warm is the whole point of the grace window.
    spy.holdPrimes.current = true;
    rendered.rerender(
      <DiffSurface visible selected editing={false} fileDiffs={FILE_DIFFS} />,
    );
    await act(async () => {});

    expect(body(rendered.container)).toBe("diff");
    expect(spy.create).toHaveBeenCalledTimes(1);
    expect(getDiffWorkerPool()).toBe(manager);
  });

  it("never terminates while a visible diff is mounted", async () => {
    setRetentionProfile(MOBILE_RETENTION_PROFILE);
    const spy = spyLifecycle();
    registerDiffWorkerPoolLifecycle(spy.lifecycle);

    const rendered = render(
      <DiffSurface visible selected editing={false} fileDiffs={FILE_DIFFS} />,
    );
    await act(async () => {});
    const manager = getDiffWorkerPool();

    await act(async () => {
      vi.advanceTimersByTime(IDLE_MS * 20);
    });

    expect(spy.terminate).not.toHaveBeenCalled();
    expect(getDiffWorkerPool()).toBe(manager);
    expect(body(rendered.container)).toBe("diff");
  });

  it("keeps a hidden surface's body and pool while an editor is mounted in it", async () => {
    setRetentionProfile(MOBILE_RETENTION_PROFILE);
    const spy = spyLifecycle();
    registerDiffWorkerPoolLifecycle(spy.lifecycle);

    const rendered = render(
      <DiffSurface visible selected editing fileDiffs={FILE_DIFFS} />,
    );
    await act(async () => {});
    const manager = getDiffWorkerPool();
    expect(body(rendered.container)).toBe("editor");

    rendered.rerender(
      <DiffSurface visible={false} selected editing fileDiffs={FILE_DIFFS} />,
    );
    await act(async () => {
      vi.advanceTimersByTime(IDLE_MS * 20);
    });

    // Dropping the body is the ONLY way to release the lease, and this body
    // holds whatever the user has typed into it. The isolate stays.
    expect(body(rendered.container)).toBe("editor");
    expect(spy.terminate).not.toHaveBeenCalled();
    expect(getDiffWorkerPool()).toBe(manager);
  });

  it("counts an unselected tab body as hidden, not only an unshown pane", async () => {
    setRetentionProfile(MOBILE_RETENTION_PROFILE);
    const spy = spyLifecycle();
    registerDiffWorkerPoolLifecycle(spy.lifecycle);

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
      vi.advanceTimersByTime(IDLE_MS);
    });

    expect(body(rendered.container)).toBe("loader");
    expect(spy.terminate).toHaveBeenCalledTimes(1);
  });

  it("does not prewarm a pool a concealed surface has stopped leasing", async () => {
    setRetentionProfile(MOBILE_RETENTION_PROFILE);
    const spy = spyLifecycle();
    registerDiffWorkerPoolLifecycle(spy.lifecycle);

    const rendered = render(
      <DiffSurface visible selected editing={false} fileDiffs={FILE_DIFFS} />,
    );
    await act(async () => {});
    const manager = spy.managers[0];
    if (manager === undefined) throw new Error("no manager");
    manager.primeDiffHighlightCache.mockClear();

    rendered.rerender(
      <DiffSurface
        visible={false}
        selected
        editing={false}
        fileDiffs={FILE_DIFFS}
      />,
    );
    await act(async () => {});
    // A background refetch inside the grace window hands the concealed gate a
    // fresh model. There is no body to highlight for, and the pool it would
    // submit to is the one this very conceal put on the clock.
    rendered.rerender(
      <DiffSurface
        visible={false}
        selected
        editing={false}
        fileDiffs={REFETCHED_FILE_DIFFS}
      />,
    );
    await act(async () => {});

    expect(manager.primeDiffHighlightCache).not.toHaveBeenCalled();
  });

  it("leaves a hidden desktop surface mounted, body and pool both", async () => {
    const spy = spyLifecycle();
    registerDiffWorkerPoolLifecycle(spy.lifecycle);

    const rendered = render(
      <DiffSurface visible selected editing={false} fileDiffs={FILE_DIFFS} />,
    );
    await act(async () => {});
    const manager = getDiffWorkerPool();

    rendered.rerender(
      <DiffSurface
        visible={false}
        selected
        editing={false}
        fileDiffs={FILE_DIFFS}
      />,
    );
    await act(async () => {
      vi.advanceTimersByTime(60 * 60_000);
    });

    // Desktop re-highlights would be visible jank on every tab switch, and the
    // renderer has the headroom the phone does not.
    expect(body(rendered.container)).toBe("diff");
    expect(spy.terminate).not.toHaveBeenCalled();
    expect(getDiffWorkerPool()).toBe(manager);
  });
});
