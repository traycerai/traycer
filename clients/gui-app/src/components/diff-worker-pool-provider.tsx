import { resolveDiffThemeName } from "@/lib/git/diff-rendering";
import { useThemeRevision } from "@/providers/use-theme-revision";
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
  registerDiffWorkerPoolLifecycle,
  subscribeDiffWorkerPool,
  unregisterDiffWorkerPoolLifecycle,
  type DiffWorkerPoolLifecycle,
} from "@/lib/diff/diff-worker-pool-demand";
import { getRetentionProfile } from "@/stores/replica-memory/retention-profile";
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
 * The pool's size is a MEMORY figure first and a throughput figure second:
 * every worker in it is a full highlighter isolate (Oniguruma WASM engine,
 * both themes, every grammar it has ever been asked for).
 *
 * Two inputs, and the smaller wins. The core count is the machine's opinion -
 * there is no point holding more isolates than there are cores to run them on.
 * `maxDiffHighlightWorkers` is the SHELL's, and it is the one that moved: three
 * on desktop (down from six, which bought little on a window that rarely shows
 * more than a handful of diffs at once), one in the installed phone app, where
 * a phone-layout shell can only ever show a single diff and the two extra
 * isolates would idle at an isolate's price each.
 *
 * The floor is not applied to the cap: an iPhone reports 6 cores, so the
 * `Math.max` arm would otherwise raise the phone back to two.
 */
function computePoolSize(): number {
  const cores =
    typeof navigator !== "undefined" ? navigator.hardwareConcurrency || 4 : 4;
  return Math.min(
    getRetentionProfile().maxDiffHighlightWorkers,
    Math.max(MIN_POOL, Math.floor(cores / 2)),
  );
}

export interface DiffWorkerPoolProviderProps {
  readonly children: ReactNode;
}

/**
 * Provides `@pierre/diffs`' worker pool to the tree WITHOUT building it at
 * mount. The pool is created on the first `acquireDiffWorkerPool()` (see
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
  useThemeRevision();
  const themeContext = use(ResolvedThemeContext);
  const currentTheme: DiffsThemeNames = resolveDiffThemeName(
    themeContext?.resolvedTheme ?? "dark",
  );
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
    const lifecycle: DiffWorkerPoolLifecycle = {
      create: () =>
        getOrCreateWorkerPoolSingleton({
          poolOptions: {
            workerFactory: () => new DiffsWorker(),
            poolSize,
          },
          highlighterOptions: {
            theme: themeRef.current,
            useTokenTransformer: true,
          },
        }),
      // Handed to the demand store as well as used below, because the pool no
      // longer only dies with this provider: under a profile with an idle
      // window the store drops it once nothing has rendered a diff for a
      // while, and the library's singleton has to be released with it or the
      // next `create` returns the terminated manager.
      terminate: terminateWorkerPoolSingleton,
    };
    registerDiffWorkerPoolLifecycle(lifecycle);
    return () => {
      unregisterDiffWorkerPoolLifecycle(lifecycle);
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
  useThemeRevision();
  const themeContext = use(ResolvedThemeContext);
  const pool = use(WorkerPoolContext);
  const resolvedTheme = themeContext?.resolvedTheme;
  const themeName = resolveDiffThemeName(resolvedTheme ?? "dark");

  useEffect(() => {
    if (resolvedTheme === undefined || pool === undefined) return;
    void pool.setRenderOptions({
      theme: themeName,
      useTokenTransformer: true,
    });
  }, [pool, resolvedTheme, themeName]);

  return null;
}
