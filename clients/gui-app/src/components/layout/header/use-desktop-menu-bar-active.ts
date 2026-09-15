import {
  resolveDesktopMenuPopupBridge,
  resolveDesktopPlatform,
} from "@/lib/windows/desktop-capabilities";
import { useRunnerHostOrNull } from "@/providers/use-runner-host";

/** Native popup capability and preload identity, independent of host readiness. */
export function useDesktopMenuBarActive(): boolean {
  const runnerHost = useRunnerHostOrNull();
  if (runnerHost === null) return false;
  const platform = resolveDesktopPlatform(runnerHost);
  return (
    (platform === "win32" || platform === "linux") &&
    resolveDesktopMenuPopupBridge(runnerHost) !== null
  );
}
