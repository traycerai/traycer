import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { createContext, useContext, type ReactNode } from "react";
import type { SetupWorkerPoolProps } from "@pierre/diffs/worker";
import { useWorkerPool } from "@pierre/diffs/react";
import { DiffWorkerPoolProvider } from "@/components/diff-worker-pool-provider";
import { ResolvedThemeContext } from "@/providers/use-resolved-theme";
import type { ResolvedThemeContextValue } from "@/providers/use-resolved-theme";
import {
  __resetDiffWorkerPoolForTests,
  acquireDiffWorkerPool,
  getDiffWorkerPool,
} from "@/lib/diff/diff-worker-pool-demand";
import {
  DESKTOP_RETENTION_PROFILE,
  MOBILE_RETENTION_PROFILE,
  setRetentionProfile,
} from "@/stores/replica-memory/retention-profile";

interface RenderOptionsArg {
  readonly theme: "pierre-light" | "pierre-dark";
  readonly useTokenTransformer: boolean;
}

interface FakeWorkerPoolManager {
  readonly setRenderOptions: Mock<(options: RenderOptionsArg) => Promise<void>>;
}

function fakeWorkerPoolManager(): FakeWorkerPoolManager {
  return { setRenderOptions: vi.fn(() => Promise.resolve()) };
}

const workerPoolMocks = vi.hoisted(() => ({
  getOrCreateWorkerPoolSingleton:
    vi.fn<(props: SetupWorkerPoolProps) => FakeWorkerPoolManager>(),
  terminateWorkerPoolSingleton: vi.fn<() => void>(),
}));

// A real React context, not a stub of one - every `@pierre/diffs` component
// reads the pool through this exact context object, so the provider under
// test and this file's own consumer probe must share the identical instance
// the library exports.
vi.mock("@pierre/diffs/react", () => {
  const context = createContext(undefined);
  return {
    WorkerPoolContext: context,
    useWorkerPool: () => useContext(context),
  };
});

vi.mock("@pierre/diffs/worker", () => ({
  getOrCreateWorkerPoolSingleton:
    workerPoolMocks.getOrCreateWorkerPoolSingleton,
  terminateWorkerPoolSingleton: workerPoolMocks.terminateWorkerPoolSingleton,
}));

vi.mock("@pierre/diffs/worker/worker.js?worker", () => ({
  default: vi.fn(() => ({})),
}));

function lightTheme(): ResolvedThemeContextValue {
  return { resolvedTheme: "light", themePreset: "neutral" };
}

function darkTheme(): ResolvedThemeContextValue {
  return { resolvedTheme: "dark", themePreset: "neutral" };
}

function PoolConsumerProbe(): ReactNode {
  const pool = useWorkerPool();
  return (
    <div data-testid="pool-state">
      {pool === undefined ? "none" : "present"}
    </div>
  );
}

describe("DiffWorkerPoolProvider", () => {
  beforeEach(() => {
    __resetDiffWorkerPoolForTests();
    workerPoolMocks.getOrCreateWorkerPoolSingleton.mockReset();
    workerPoolMocks.terminateWorkerPoolSingleton.mockReset();
  });

  afterEach(() => {
    cleanup();
    __resetDiffWorkerPoolForTests();
    setRetentionProfile(DESKTOP_RETENTION_PROFILE);
  });

  it("renders children", () => {
    render(
      <ResolvedThemeContext.Provider value={lightTheme()}>
        <DiffWorkerPoolProvider>
          <div data-testid="test-child">Child content</div>
        </DiffWorkerPoolProvider>
      </ResolvedThemeContext.Provider>,
    );

    expect(screen.getByTestId("test-child")).toBeDefined();
    expect(screen.getByText("Child content")).toBeDefined();
  });

  it("does not create the pool at mount", () => {
    render(
      <ResolvedThemeContext.Provider value={lightTheme()}>
        <DiffWorkerPoolProvider>
          <PoolConsumerProbe />
        </DiffWorkerPoolProvider>
      </ResolvedThemeContext.Provider>,
    );

    expect(
      workerPoolMocks.getOrCreateWorkerPoolSingleton,
    ).not.toHaveBeenCalled();
    expect(screen.getByTestId("pool-state").textContent).toBe("none");
    expect(getDiffWorkerPool()).toBeUndefined();
  });

  it("creates the pool on acquireDiffWorkerPool() and the consumer then sees it via context", () => {
    const manager = fakeWorkerPoolManager();
    workerPoolMocks.getOrCreateWorkerPoolSingleton.mockReturnValue(manager);

    render(
      <ResolvedThemeContext.Provider value={lightTheme()}>
        <DiffWorkerPoolProvider>
          <PoolConsumerProbe />
        </DiffWorkerPoolProvider>
      </ResolvedThemeContext.Provider>,
    );

    expect(screen.getByTestId("pool-state").textContent).toBe("none");

    act(() => {
      acquireDiffWorkerPool();
    });

    expect(screen.getByTestId("pool-state").textContent).toBe("present");
    expect(
      workerPoolMocks.getOrCreateWorkerPoolSingleton,
    ).toHaveBeenCalledTimes(1);

    const [options] =
      workerPoolMocks.getOrCreateWorkerPoolSingleton.mock.calls[0];
    expect(options.poolOptions.poolSize).toBeGreaterThanOrEqual(2);
    expect(options.poolOptions.poolSize).toBeLessThanOrEqual(3);
    expect(options.highlighterOptions).toEqual({
      theme: "pierre-light",
      useTokenTransformer: true,
    });
  });

  it("does not call setRenderOptions before the pool exists, and calls it with the light theme once requested", () => {
    const manager = fakeWorkerPoolManager();
    workerPoolMocks.getOrCreateWorkerPoolSingleton.mockReturnValue(manager);

    render(
      <ResolvedThemeContext.Provider value={lightTheme()}>
        <DiffWorkerPoolProvider>
          <div>Test</div>
        </DiffWorkerPoolProvider>
      </ResolvedThemeContext.Provider>,
    );

    expect(manager.setRenderOptions).not.toHaveBeenCalled();

    act(() => {
      acquireDiffWorkerPool();
    });

    expect(manager.setRenderOptions).toHaveBeenCalledWith({
      theme: "pierre-light",
      useTokenTransformer: true,
    });
  });

  it("calls setRenderOptions with the dark theme once requested", () => {
    const manager = fakeWorkerPoolManager();
    workerPoolMocks.getOrCreateWorkerPoolSingleton.mockReturnValue(manager);

    render(
      <ResolvedThemeContext.Provider value={darkTheme()}>
        <DiffWorkerPoolProvider>
          <div>Test</div>
        </DiffWorkerPoolProvider>
      </ResolvedThemeContext.Provider>,
    );

    act(() => {
      acquireDiffWorkerPool();
    });

    expect(manager.setRenderOptions).toHaveBeenCalledWith({
      theme: "pierre-dark",
      useTokenTransformer: true,
    });
  });

  it("sizes the pool at one worker under the mobile profile", () => {
    // An iPhone reports 6 hardware threads, so the core-count arm alone would
    // hand the phone the desktop's cap. The profile is what holds it to one
    // highlighter isolate.
    setRetentionProfile(MOBILE_RETENTION_PROFILE);
    const manager = fakeWorkerPoolManager();
    workerPoolMocks.getOrCreateWorkerPoolSingleton.mockReturnValue(manager);

    render(
      <ResolvedThemeContext.Provider value={lightTheme()}>
        <DiffWorkerPoolProvider>
          <PoolConsumerProbe />
        </DiffWorkerPoolProvider>
      </ResolvedThemeContext.Provider>,
    );

    act(() => {
      acquireDiffWorkerPool();
    });

    const [options] =
      workerPoolMocks.getOrCreateWorkerPoolSingleton.mock.calls[0];
    expect(options.poolOptions.poolSize).toBe(1);
  });

  it("honors a lease taken before the provider mounts", () => {
    const manager = fakeWorkerPoolManager();
    workerPoolMocks.getOrCreateWorkerPoolSingleton.mockReturnValue(manager);

    acquireDiffWorkerPool();
    expect(getDiffWorkerPool()).toBeUndefined();

    render(
      <ResolvedThemeContext.Provider value={lightTheme()}>
        <DiffWorkerPoolProvider>
          <PoolConsumerProbe />
        </DiffWorkerPoolProvider>
      </ResolvedThemeContext.Provider>,
    );

    expect(
      workerPoolMocks.getOrCreateWorkerPoolSingleton,
    ).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("pool-state").textContent).toBe("present");
    expect(getDiffWorkerPool()).toBe(manager);
  });

  it("terminates the pool on unmount and clears the store", () => {
    const manager = fakeWorkerPoolManager();
    workerPoolMocks.getOrCreateWorkerPoolSingleton.mockReturnValue(manager);

    const rendered = render(
      <ResolvedThemeContext.Provider value={lightTheme()}>
        <DiffWorkerPoolProvider>
          <PoolConsumerProbe />
        </DiffWorkerPoolProvider>
      </ResolvedThemeContext.Provider>,
    );

    act(() => {
      acquireDiffWorkerPool();
    });
    expect(getDiffWorkerPool()).toBe(manager);

    rendered.unmount();

    expect(workerPoolMocks.terminateWorkerPoolSingleton).toHaveBeenCalled();
    expect(getDiffWorkerPool()).toBeUndefined();
  });
});
