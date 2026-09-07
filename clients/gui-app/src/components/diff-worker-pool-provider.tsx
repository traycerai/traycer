import type { DiffsThemeNames } from "@pierre/diffs";
import { WorkerPoolContext } from "@pierre/diffs/react";
import {
  getOrCreateWorkerPoolSingleton,
  terminateWorkerPoolSingleton,
} from "@pierre/diffs/worker";
import DiffsWorker from "@pierre/diffs/worker/worker.js?worker";
import { ResolvedThemeContext } from "@/providers/use-resolved-theme";
import {
  getDiffWorkerPool,
  registerDiffWorkerPoolCreator,
  subscribeDiffWorkerPool,
  unregisterDiffWorkerPoolCreator,
} from "@/lib/diff/diff-worker-pool-demand";
import {
  use,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
  type ReactNode,
} from "react";

const MIN_POOL = 2;
/**
 * Three, down from six. Every pool worker is a full highlighter isolate
 * (Oniguruma WASM engine, both themes, every grammar it has ever been asked
 * for), so the pool's size is a memory figure first and a throughput figure
 * second. Three workers keep a multi-file diff rendering in parallel; six
 * bought little beyond that on a desktop that rarely has more than a handful
 * of diffs visible at once, and cost a highlighter isolate each.
 */
const MAX_POOL = 3;

function computePoolSize(): number {
  const cores =
    typeof navigator !== "undefined" ? navigator.hardwareConcurrency || 4 : 4;
  return Math.min(MAX_POOL, Math.max(MIN_POOL, Math.floor(cores / 2)));
}

export interface DiffWorkerPoolProviderProps {
  readonly children: ReactNode;
}

/**
 * Provides `@pierre/diffs`' worker pool to the tree WITHOUT building it at
 * mount. The pool is created on the first `requestDiffWorkerPool()` (see
 * `lib/diff/diff-worker-pool-demand.ts` for why), and this provider is what
 * knows the recipe: the pool size, the worker factory Vite must see literally,
 * and the theme the highlighter should start with.
 *
 * Renders the library's own context (`WorkerPoolContext`) rather than its
 * `WorkerPoolContextProvider`, because that provider constructs the pool in a
 * `useState` initializer - there is no way to hand it a pool later. Every
 * `@pierre/diffs` React component reads this same context, so they see the
 * pool the moment it exists.
 */
export function DiffWorkerPoolProvider(
  props: DiffWorkerPoolProviderProps,
): ReactNode {
  const poolSize = useMemo(() => computePoolSize(), []);
  const themeContext = use(ResolvedThemeContext);
  const currentTheme: DiffsThemeNames =
    themeContext?.resolvedTheme === "light" ? "pierre-light" : "pierre-dark";
  const pool = useSyncExternalStore(
    subscribeDiffWorkerPool,
    getDiffWorkerPool,
    getDiffWorkerPool,
  );

  // The theme the pool is SEEDED with is whichever is current when it is
  // built, which can be long after this provider mounted. A ref, so the
  // creator registered below reads the live value without the theme becoming
  // a dependency of the registration - re-registering on a theme change would
  // unregister the live pool. `ThemeSync` keeps the pool current after that.
  const themeRef = useRef(currentTheme);
  useLayoutEffect(() => {
    themeRef.current = currentTheme;
  }, [currentTheme]);

  // Layout effect, not effect: a diff surface mounted in this same commit
  // requests the pool from its own effect, and effects run child-first. The
  // creator has to be registered before that request lands or the request
  // reads "unavailable" and the surface takes the main-thread path.
  useLayoutEffect(() => {
    const creator = () =>
      getOrCreateWorkerPoolSingleton({
        poolOptions: {
          workerFactory: () => new DiffsWorker(),
          poolSize,
        },
        highlighterOptions: {
          theme: themeRef.current,
          useTokenTransformer: true,
        },
      });
    registerDiffWorkerPoolCreator(creator);
    return () => {
      unregisterDiffWorkerPoolCreator(creator);
      terminateWorkerPoolSingleton();
    };
  }, [poolSize]);

  return (
    <WorkerPoolContext.Provider value={pool}>
      <ThemeSync />
      {props.children}
    </WorkerPoolContext.Provider>
  );
}

function ThemeSync(): ReactNode {
  // Defensive: in tests that mount without <ThemeProvider> (e.g. app-shell
  // bridge tests), the context is null. Skip the sync; production always has
  // ThemeProvider above this.
  const themeContext = use(ResolvedThemeContext);
  const pool = use(WorkerPoolContext);
  const resolvedTheme = themeContext?.resolvedTheme;

  useEffect(() => {
    if (resolvedTheme === undefined || pool === undefined) return;
    void pool.setRenderOptions({
      theme: resolvedTheme === "dark" ? "pierre-dark" : "pierre-light",
      useTokenTransformer: true,
    });
  }, [pool, resolvedTheme]);

  return null;
}
