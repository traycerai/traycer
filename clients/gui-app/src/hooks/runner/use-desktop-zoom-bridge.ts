import { useMemo } from "react";
import { resolveDesktopZoomBridge } from "@/lib/windows/desktop-capabilities";
import type { DesktopZoomBridge } from "@/lib/windows/types";
import { useRunnerHost } from "@/providers/use-runner-host";

export function useDesktopZoomBridge(): DesktopZoomBridge | null {
  const runnerHost = useRunnerHost();
  return useMemo(() => resolveDesktopZoomBridge(runnerHost), [runnerHost]);
}
