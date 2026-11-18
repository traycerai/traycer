import { useMemo } from "react";
import { resolveDesktopTrackpadScrollPhaseBridge } from "@/lib/windows/desktop-capabilities";
import type { DesktopTrackpadScrollPhaseBridge } from "@/lib/windows/types";
import { useRunnerHost } from "@/providers/use-runner-host";

export function useDesktopTrackpadScrollPhaseBridge(): DesktopTrackpadScrollPhaseBridge | null {
  const runnerHost = useRunnerHost();
  return useMemo(
    () => resolveDesktopTrackpadScrollPhaseBridge(runnerHost),
    [runnerHost],
  );
}
