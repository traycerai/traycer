import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import type { FileContents, FileDiffMetadata } from "@pierre/diffs";
import type { WorkerPoolManager } from "@pierre/diffs/worker";
import {
  useDiffsDiffEditHighlightReady,
  useDiffsDiffHighlightReady,
  useDiffsFileHighlightReady,
} from "@/components/diff/use-diff-highlight-ready";
import { DiffHighlightLoading } from "@/components/diff/diff-highlight-loading";
import {
  __resetDiffWorkerPoolForTests,
  getDiffWorkerPool,
  registerDiffWorkerPoolCreator,
} from "@/lib/diff/diff-worker-pool-demand";

interface FakeWorkerPoolManager {
  setRenderOptions: Mock;
  primeFileHighlightCache: Mock;
  primeDiffHighlightCache: Mock;
}

const poolState = vi.hoisted(() => ({
  pool: undefined as FakeWorkerPoolManager | undefined,
}));

vi.mock("@pierre/diffs/react", () => ({
  useWorkerPool: () => poolState.pool,
  EditProvider: (props: { readonly children: unknown }) => props.children,
}));

/**
 * A fake `WorkerPoolManager`. The real class has ~90 members, so a literal
 * with three of them does not overlap enough for a direct `as`, and
 * `as unknown as` is lint-forbidden here. The same seam the diagnostics test
 * support uses instead: a prototype-less object asserted to the class type,
 * then the three members the gates actually call assigned onto it. Only the
 * demand store's `manager` field (typed against the real class) ever sees
 * it; every assertion in this file reads the fake object directly.
 */
function fakeWorkerPoolManager(): FakeWorkerPoolManager {
  return {
    setRenderOptions: vi.fn(() => Promise.resolve()),
    primeFileHighlightCache: vi.fn(() => Promise.resolve()),
    primeDiffHighlightCache: vi.fn(() => Promise.resolve()),
  };
}

function asWorkerPoolManager(fake: FakeWorkerPoolManager): WorkerPoolManager {
  return Object.assign(Object.create(null) as WorkerPoolManager, fake);
}

describe("useDiffs highlight gates", () => {
  beforeEach(() => {
    poolState.pool = undefined;
    __resetDiffWorkerPoolForTests();
  });

  afterEach(() => {
    cleanup();
    __resetDiffWorkerPoolForTests();
  });

  it("releases a surface once it has requested the pool with no provider mounted (availability 'unavailable')", () => {
    render(<FileReadyProbe file={sampleFile()} theme="pierre-dark" enabled />);
    expect(screen.getByTestId("ready").textContent).toBe("ready");
  });

  it("keeps the file surface gated until primeFileHighlightCache resolves", async () => {
    let resolvePrime: (() => void) | null = null;
    const primePromise = new Promise<void>((resolve) => {
      resolvePrime = resolve;
    });
    const setRenderOptions = vi.fn(() => Promise.resolve());
    const primeFileHighlightCache = vi.fn(() => primePromise);
    poolState.pool = {
      setRenderOptions,
      primeFileHighlightCache,
      primeDiffHighlightCache: vi.fn(() => Promise.resolve()),
    };

    render(<FileReadyProbe file={sampleFile()} theme="pierre-dark" enabled />);

    expect(screen.getByTestId("ready").textContent).toBe("pending");
    await waitFor(() => {
      expect(primeFileHighlightCache).toHaveBeenCalledWith(sampleFile());
    });
    expect(setRenderOptions).not.toHaveBeenCalled();

    await act(async () => {
      resolvePrime?.();
      await primePromise;
    });

    await waitFor(() => {
      expect(screen.getByTestId("ready").textContent).toBe("ready");
    });
  });

  it("keeps the diff surface gated until every primeDiffHighlightCache call resolves", async () => {
    let resolvePrime: (() => void) | null = null;
    const primePromise = new Promise<void>((resolve) => {
      resolvePrime = resolve;
    });
    const setRenderOptions = vi.fn(() => Promise.resolve());
    const primeDiffHighlightCache = vi.fn(() => primePromise);
    poolState.pool = {
      setRenderOptions,
      primeFileHighlightCache: vi.fn(() => Promise.resolve()),
      primeDiffHighlightCache,
    };
    const fileDiffs = [sampleDiff("a.ts"), sampleDiff("b.ts")];

    render(
      <DiffReadyProbe fileDiffs={fileDiffs} theme="pierre-light" enabled />,
    );

    expect(screen.getByTestId("ready").textContent).toBe("pending");
    await waitFor(() => {
      expect(primeDiffHighlightCache).toHaveBeenCalledTimes(2);
    });
    expect(setRenderOptions).not.toHaveBeenCalled();

    await act(async () => {
      resolvePrime?.();
      await primePromise;
    });

    await waitFor(() => {
      expect(screen.getByTestId("ready").textContent).toBe("ready");
    });
  });

  it("never closes an already released file surface for later cache misses", async () => {
    let resolveFirst: (() => void) | null = null;
    const firstPrime = new Promise<void>((resolve) => {
      resolveFirst = resolve;
    });
    const neverSettles = new Promise<void>(() => undefined);
    const primeFileHighlightCache = vi
      .fn()
      .mockReturnValueOnce(firstPrime)
      .mockReturnValueOnce(neverSettles);
    poolState.pool = {
      setRenderOptions: vi.fn(() => Promise.resolve()),
      primeFileHighlightCache,
      primeDiffHighlightCache: vi.fn(() => Promise.resolve()),
    };
    const rendered = render(
      <FileReadyProbe file={sampleFile()} theme="pierre-dark" enabled />,
    );
    await act(async () => {
      resolveFirst?.();
      await firstPrime;
    });
    await waitFor(() => {
      expect(screen.getByTestId("ready").textContent).toBe("ready");
    });

    rendered.rerender(
      <FileReadyProbe
        file={{ ...sampleFile(), contents: "const value = 2;\n" }}
        theme="pierre-light"
        enabled
      />,
    );

    expect(screen.getByTestId("ready").textContent).toBe("ready");
    await waitFor(() => {
      expect(primeFileHighlightCache).toHaveBeenCalledTimes(2);
    });
  });

  it("renders DiffHighlightLoading with the requested test id", () => {
    render(<DiffHighlightLoading testId="workspace-file-highlighting" />);
    expect(screen.getByTestId("workspace-file-highlighting")).toBeTruthy();
  });

  it("keeps both the file and diff gates closed once a creator is registered but the context has not caught up yet", async () => {
    const manager = fakeWorkerPoolManager();
    registerDiffWorkerPoolCreator(() => asWorkerPoolManager(manager));
    // `poolState.pool` stays undefined on purpose: the store already built the
    // manager, but the provider that would carry it into context has not
    // re-rendered in this test, so `useWorkerPool()` still answers undefined.

    render(<FileReadyProbe file={sampleFile()} theme="pierre-dark" enabled />);
    expect(screen.getByTestId("ready").textContent).toBe("pending");
    await act(async () => {});
    expect(screen.getByTestId("ready").textContent).toBe("pending");
    cleanup();

    render(
      <DiffReadyProbe
        fileDiffs={[sampleDiff("a.ts")]}
        theme="pierre-light"
        enabled
      />,
    );
    expect(screen.getByTestId("ready").textContent).toBe("pending");
    await act(async () => {});
    expect(screen.getByTestId("ready").textContent).toBe("pending");
  });

  it("requests the pool from the hook's own mount effect, so a registered creator builds it", () => {
    const manager = asWorkerPoolManager(fakeWorkerPoolManager());
    registerDiffWorkerPoolCreator(() => manager);
    expect(getDiffWorkerPool()).toBeUndefined();

    render(<FileReadyProbe file={sampleFile()} theme="pierre-dark" enabled />);

    expect(getDiffWorkerPool()).toBe(manager);
  });

  it("releases the file gate once the context catches up with the pool the creator built", async () => {
    const manager = fakeWorkerPoolManager();
    registerDiffWorkerPoolCreator(() => asWorkerPoolManager(manager));

    const rendered = render(
      <FileReadyProbe file={sampleFile()} theme="pierre-dark" enabled />,
    );
    expect(screen.getByTestId("ready").textContent).toBe("pending");

    poolState.pool = manager;
    rendered.rerender(
      <FileReadyProbe file={sampleFile()} theme="pierre-dark" enabled />,
    );

    await waitFor(() => {
      expect(manager.primeFileHighlightCache).toHaveBeenCalledWith(
        sampleFile(),
      );
    });
    await waitFor(() => {
      expect(screen.getByTestId("ready").textContent).toBe("ready");
    });
  });

  it("releases the diff gate once the context catches up with the pool the creator built", async () => {
    const manager = fakeWorkerPoolManager();
    registerDiffWorkerPoolCreator(() => asWorkerPoolManager(manager));
    const fileDiffs = [sampleDiff("a.ts")];

    const rendered = render(
      <DiffReadyProbe fileDiffs={fileDiffs} theme="pierre-light" enabled />,
    );
    expect(screen.getByTestId("ready").textContent).toBe("pending");

    poolState.pool = manager;
    rendered.rerender(
      <DiffReadyProbe fileDiffs={fileDiffs} theme="pierre-light" enabled />,
    );

    await waitFor(() => {
      expect(manager.primeDiffHighlightCache).toHaveBeenCalledWith(
        fileDiffs[0],
      );
    });
    await waitFor(() => {
      expect(screen.getByTestId("ready").textContent).toBe("ready");
    });
  });

  it("releases the edit gate when no creator is registered (availability 'unavailable')", () => {
    render(
      <EditReadyProbe
        fileDiffs={[sampleDiff("a.ts")]}
        theme="pierre-dark"
        enabled
      />,
    );
    expect(screen.getByTestId("ready").textContent).toBe("ready");
  });

  it("keeps the edit gate closed when a creator is registered but no pool is in context yet", async () => {
    const manager = fakeWorkerPoolManager();
    registerDiffWorkerPoolCreator(() => asWorkerPoolManager(manager));

    render(
      <EditReadyProbe
        fileDiffs={[sampleDiff("a.ts")]}
        theme="pierre-dark"
        enabled
      />,
    );
    expect(screen.getByTestId("ready").textContent).toBe("pending");
    await act(async () => {});
    expect(screen.getByTestId("ready").textContent).toBe("pending");
  });

  it("requests the pool from a disabled gate that has work, but holds release until the pool reaches context", () => {
    // The file gate's demand signal is `useDiffWorkerPoolAvailability(true)` -
    // always has work, independent of `enabled` - so a disabled gate still
    // asks for the pool instead of skipping the request.
    const manager = asWorkerPoolManager(fakeWorkerPoolManager());
    registerDiffWorkerPoolCreator(() => manager);

    render(
      <FileReadyProbe
        file={sampleFile()}
        theme="pierre-dark"
        enabled={false}
      />,
    );

    expect(getDiffWorkerPool()).toBe(manager);
    // Only the store built a manager; no pool has reached React context yet,
    // so the gate holds rather than releasing instantly for being disabled.
    expect(screen.getByTestId("ready").textContent).toBe("pending");
  });

  it("holds a disabled gate until the pool reaches context, releases once it does, and never re-closes when enabled later flips true", () => {
    const manager = fakeWorkerPoolManager();
    registerDiffWorkerPoolCreator(() => asWorkerPoolManager(manager));

    const rendered = render(
      <FileReadyProbe
        file={sampleFile()}
        theme="pierre-dark"
        enabled={false}
      />,
    );
    // The store already built the manager (the file gate always has work),
    // but the provider has not carried it into context yet - the gate holds.
    expect(screen.getByTestId("ready").textContent).toBe("pending");

    // The provider re-renders and the pool reaches context. Still disabled.
    poolState.pool = manager;
    rendered.rerender(
      <FileReadyProbe
        file={sampleFile()}
        theme="pierre-dark"
        enabled={false}
      />,
    );

    // Releases because `!enabled`, not because a cache prime resolved - a
    // disabled gate never waits on one.
    expect(screen.getByTestId("ready").textContent).toBe("ready");
    expect(manager.primeFileHighlightCache).not.toHaveBeenCalled();

    // The regression this pins: an editor that mounted disabled (an edit
    // session in progress) and is later enabled (the session ends) must stay
    // released - never close the gate again and replace the mounted editor
    // with DiffHighlightLoading.
    rendered.rerender(
      <FileReadyProbe file={sampleFile()} theme="pierre-dark" enabled />,
    );
    expect(screen.getByTestId("ready").textContent).toBe("ready");
  });

  it("does not request the pool for an empty diff list", () => {
    const manager = asWorkerPoolManager(fakeWorkerPoolManager());
    registerDiffWorkerPoolCreator(() => manager);

    render(<DiffReadyProbe fileDiffs={[]} theme="pierre-dark" enabled />);
    render(<EditReadyProbe fileDiffs={[]} theme="pierre-dark" enabled />);

    expect(getDiffWorkerPool()).toBeUndefined();
    for (const probe of screen.getAllByTestId("ready")) {
      expect(probe.textContent).toBe("ready");
    }
  });
});

function FileReadyProbe(props: {
  readonly file: FileContents;
  readonly theme: "pierre-dark" | "pierre-light";
  readonly enabled: boolean;
}) {
  const ready = useDiffsFileHighlightReady(props);
  return <div data-testid="ready">{ready ? "ready" : "pending"}</div>;
}

function DiffReadyProbe(props: {
  readonly fileDiffs: ReadonlyArray<FileDiffMetadata>;
  readonly theme: "pierre-dark" | "pierre-light";
  readonly enabled: boolean;
}) {
  const ready = useDiffsDiffHighlightReady(props);
  return <div data-testid="ready">{ready ? "ready" : "pending"}</div>;
}

function EditReadyProbe(props: {
  readonly fileDiffs: ReadonlyArray<FileDiffMetadata>;
  readonly theme: "pierre-dark" | "pierre-light";
  readonly enabled: boolean;
}) {
  const ready = useDiffsDiffEditHighlightReady(props);
  return <div data-testid="ready">{ready ? "ready" : "pending"}</div>;
}

function sampleFile(): FileContents {
  return {
    name: "source.ts",
    contents: "const value = 1;\n",
    lang: "typescript",
    cacheKey: "workspace-file:source.ts",
  };
}

function sampleDiff(name: string): FileDiffMetadata {
  return { name } as FileDiffMetadata;
}
