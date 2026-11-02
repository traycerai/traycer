import { useCallback, useEffect, useMemo, useState } from "react";
import type { SandboxStatus } from "@/lib/sandbox/bridge-host";

const EMPTY: ReadonlySet<string> = new Set();
const CONCURRENT_MOUNTS = 3;
const HIDDEN_RETENTION_MS = 3 * 60 * 1000;

interface Mounts {
  readonly selection: ReadonlySet<string>;
  readonly boards: ReadonlyMap<string, boolean>;
}

function admitBoards(
  selection: ReadonlySet<string>,
  previous: ReadonlyMap<string, boolean>,
): Mounts {
  const boards = new Map([...previous].filter(([path]) => selection.has(path)));
  let loading = [...boards.values()].filter(Boolean).length;
  for (const path of selection) {
    if (loading >= CONCURRENT_MOUNTS) break;
    if (boards.has(path)) continue;
    boards.set(path, true);
    loading++;
  }
  return { selection, boards };
}

export function useCanvasBoardMounts(
  desired: ReadonlySet<string>,
  visible: boolean,
): {
  readonly liveBoards: ReadonlySet<string>;
  readonly onBoardStatus: (path: string, status: SandboxStatus) => void;
} {
  const [released, setReleased] = useState(false);
  const [mounts, setMounts] = useState<Mounts>(() =>
    admitBoards(visible ? desired : EMPTY, new Map()),
  );
  useEffect(() => {
    if (visible) return;
    const timer = window.setTimeout(
      () => setReleased(true),
      HIDDEN_RETENTION_MS,
    );
    return () => window.clearTimeout(timer);
  }, [visible]);
  if (visible && released) setReleased(false);
  // Hidden panes report zero geometry. Keep the actual working set until the
  // grace period expires, rather than selecting boards around that false view.
  const hiddenSelection = released ? EMPTY : mounts.selection;
  const selection = visible ? desired : hiddenSelection;
  if (selection !== mounts.selection) {
    setMounts(admitBoards(selection, mounts.boards));
  }
  const onBoardStatus = useCallback((path: string, status: SandboxStatus) => {
    if (status !== "ready" && status !== "crashed") return;
    setMounts((current) => {
      if (current.boards.get(path) !== true) return current;
      const boards = new Map(current.boards);
      boards.set(path, false);
      return admitBoards(current.selection, boards);
    });
  }, []);
  const liveBoards = useMemo(
    () => new Set(mounts.boards.keys()),
    [mounts.boards],
  );
  return { liveBoards, onBoardStatus };
}
