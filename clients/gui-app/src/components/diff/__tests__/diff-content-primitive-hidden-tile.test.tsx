import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import type { FileDiffMetadata } from "@pierre/diffs";
import type { WorkerPoolManager, WorkerStats } from "@pierre/diffs/worker";
import { useEffect, type ReactNode } from "react";
import { DiffContentPrimitive } from "@/components/diff/diff-content-primitive";
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
 * Mount and unmount counts per inline diff, keyed by file name. A body that is
 * dropped and rebuilt on return is exactly what shifts a transcript row's
 * measured height and with it the reading position, so "mounted once, never
 * unmounted" is the assertion that pins both.
 */
const lifecycle = vi.hoisted(() => ({
  mounts: new Map<string, number>(),
  unmounts: new Map<string, number>(),
}));

function bump(counts: Map<string, number>, name: string): void {
  counts.set(name, (counts.get(name) ?? 0) + 1);
}

/**
 * `useWorkerPool()` wired to the demand store the way `DiffWorkerPoolProvider`
 * wires it, and `<FileDiff>` replaced by a fixed-height row that records its
 * lifecycle. Everything else - the patch parse, both gates, the loader branch
 * - is the production `DiffContentPrimitive`.
 */
vi.mock("@pierre/diffs/react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@pierre/diffs/react")>();
  const { useSyncExternalStore } = await import("react");
  const { getDiffWorkerPool: read, subscribeDiffWorkerPool: subscribe } =
    await import("@/lib/diff/diff-worker-pool-demand");
  function InstrumentedFileDiff(props: {
    readonly fileDiff: FileDiffMetadata;
  }): ReactNode {
    const { name } = props.fileDiff;
    useEffect(() => {
      bump(lifecycle.mounts, name);
      return () => bump(lifecycle.unmounts, name);
    }, [name]);
    return (
      <div
        data-testid="inline-diff-body"
        data-name={name}
        style={{ height: "120px" }}
      />
    );
  }
  return {
    ...actual,
    useWorkerPool: () => useSyncExternalStore(subscribe, read, read),
    FileDiff: InstrumentedFileDiff,
  };
});

vi.mock("@/providers/use-resolved-theme", () => ({
  useResolvedTheme: () => ({
    resolvedTheme: "light",
    themePreset: "neutral",
  }),
}));

interface FakeWorkerPoolManagerMembers {
  readonly setRenderOptions: () => Promise<void>;
  readonly primeFileHighlightCache: () => Promise<void>;
  readonly primeDiffHighlightCache: () => Promise<void>;
  readonly getStats: () => WorkerStats;
  readonly subscribeToStatChanges: () => () => void;
  readonly terminate: () => void;
}

interface FakePool {
  readonly manager: WorkerPoolManager;
  readonly terminations: () => number;
}

/**
 * A prototype-less object asserted to the ~90-member class (`as unknown as`
 * is lint-forbidden), reporting one live idle worker until `terminate`.
 */
function fakePool(): FakePool {
  let totalWorkers = 1;
  let terminations = 0;
  const members: FakeWorkerPoolManagerMembers = {
    setRenderOptions: () => Promise.resolve(),
    primeFileHighlightCache: () => Promise.resolve(),
    primeDiffHighlightCache: () => Promise.resolve(),
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
    terminate: () => {
      totalWorkers = 0;
      terminations += 1;
    },
  };
  return {
    manager: Object.assign(Object.create(null) as WorkerPoolManager, members),
    terminations: () => terminations,
  };
}

function patchFor(path: string): string {
  return `diff --git a/${path} b/${path}
index 1111111..2222222 100644
--- a/${path}
+++ b/${path}
@@ -1,3 +1,3 @@
 context before
-old line
+new line
 context after
`;
}

const CHANGED_FILES = ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts"];

/**
 * A chat tile's transcript reduced to what matters here: a scroll container of
 * rows, each an inline file change rendered with the props
 * `file-change-segment.tsx` passes, under the two contexts
 * `useTileBodyVisible()` reads.
 */
function ChatTile(props: { readonly visible: boolean }): ReactNode {
  return (
    <PaneVisibilityContext.Provider value={props.visible}>
      <TabBodySelectedContext.Provider value>
        <div data-testid="transcript" style={{ overflowY: "auto" }}>
          {CHANGED_FILES.map((path) => (
            <div key={path} data-testid="row">
              <DiffContentPrimitive
                patch={patchFor(path)}
                cacheScope={`inline:${path}`}
                mode="unified"
                wordWrap={false}
                backgrounds
                lineNumbers={false}
                indicatorStyle="bars"
                fileHeaders={false}
                isEmptyFile={false}
              />
            </div>
          ))}
        </div>
      </TabBodySelectedContext.Provider>
    </PaneVisibilityContext.Provider>
  );
}

function bodies(container: HTMLElement): ReadonlyArray<Element> {
  return Array.from(
    container.querySelectorAll("[data-testid='inline-diff-body']"),
  );
}

function loaders(container: HTMLElement): number {
  return container.querySelectorAll("[data-testid='diff-highlighting']").length;
}

describe("inline diffs in a chat tile that is hidden and shown again", () => {
  beforeEach(() => {
    __resetDiffWorkerPoolForTests();
    lifecycle.mounts.clear();
    lifecycle.unmounts.clear();
    vi.useFakeTimers();
    setRetentionProfile(MOBILE_RETENTION_PROFILE);
  });

  afterEach(() => {
    cleanup();
    __resetDiffWorkerPoolForTests();
    setRetentionProfile(DESKTOP_RETENTION_PROFILE);
    vi.useRealTimers();
  });

  it("keeps every diff body, its row height and the scroll position through a release of the pool", async () => {
    const pool = fakePool();
    registerDiffWorkerPoolCreator(() => pool.manager);

    const rendered = render(<ChatTile visible />);
    await act(async () => {});
    const shown = bodies(rendered.container);
    expect(shown).toHaveLength(CHANGED_FILES.length);
    const transcript = rendered.getByTestId("transcript");
    transcript.scrollTop = 240;

    rendered.rerender(<ChatTile visible={false} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(
        MOBILE_RETENTION_PROFILE.diffWorkerPoolIdleMs,
      );
    });
    // The release really happened while the tile was hidden: the workers are
    // gone, the manager every body captured is not.
    expect(pool.terminations()).toBe(1);
    expect(getDiffWorkerPool()).toBe(pool.manager);
    expect(loaders(rendered.container)).toBe(0);

    rendered.rerender(<ChatTile visible />);
    await act(async () => {});

    // jsdom has no layout, so the heights are pinned the only way they could
    // change: the same body nodes, never swapped for the loader and never
    // remounted, each still carrying the height it was measured at.
    const returned = bodies(rendered.container);
    expect(returned).toHaveLength(CHANGED_FILES.length);
    returned.forEach((node, index) => {
      expect(node).toBe(shown[index]);
      expect(node instanceof HTMLElement && node.style.height).toBe("120px");
    });
    expect(loaders(rendered.container)).toBe(0);
    for (const path of CHANGED_FILES) {
      expect(lifecycle.mounts.get(path)).toBe(1);
      expect(lifecycle.unmounts.get(path) ?? 0).toBe(0);
    }
    expect(rendered.getByTestId("transcript")).toBe(transcript);
    expect(transcript.scrollTop).toBe(240);
  });
});
