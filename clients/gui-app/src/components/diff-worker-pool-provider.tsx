import { WorkerPoolContextProvider, useWorkerPool } from "@pierre/diffs/react";
import DiffsWorker from "@pierre/diffs/worker/worker.js?worker";
import { ResolvedThemeContext } from "@/providers/use-resolved-theme";
import { use, useEffect, useMemo, type ReactNode } from "react";

const MIN_POOL = 2;
const MAX_POOL = 6;

function computePoolSize(): number {
  const cores =
    typeof navigator !== "undefined" ? navigator.hardwareConcurrency || 4 : 4;
  return Math.min(MAX_POOL, Math.max(MIN_POOL, Math.floor(cores / 2)));
}

export interface DiffWorkerPoolProviderProps {
  readonly children: ReactNode;
}

export function DiffWorkerPoolProvider(
  props: DiffWorkerPoolProviderProps,
): ReactNode {
  const poolSize = useMemo(() => computePoolSize(), []);

  return (
    <WorkerPoolContextProvider
      poolOptions={{
        workerFactory: () => new DiffsWorker(),
        poolSize,
      }}
      highlighterOptions={{}}
    >
      <ThemeSync />
      {props.children}
    </WorkerPoolContextProvider>
  );
}

function ThemeSync(): ReactNode {
  // Defensive: in tests that mount without <ThemeProvider> (e.g. app-shell
  // bridge tests), the context is null. Skip the sync; production always has
  // ThemeProvider above this.
  const themeContext = use(ResolvedThemeContext);
  const pool = useWorkerPool();
  const resolvedTheme = themeContext?.resolvedTheme;

  useEffect(() => {
    if (resolvedTheme === undefined || pool === undefined) return;
    void pool.setRenderOptions({
      theme: resolvedTheme === "dark" ? "pierre-dark" : "pierre-light",
    });
  }, [pool, resolvedTheme]);

  return null;
}
