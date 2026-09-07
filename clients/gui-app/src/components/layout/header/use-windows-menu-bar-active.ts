import { isWindows } from "@/lib/keybindings/platform";
import { resolveDesktopMenuPopupBridge } from "@/lib/windows/desktop-capabilities";
import { useRunnerHostOrNull } from "@/providers/use-runner-host";

/** Whether the Windows frameless menu strip renders at all: only on a Windows desktop shell whose bridge can
 * pop up native submenus. */
export function useWindowsMenuBarActive(): boolean {
  const runnerHost = useRunnerHostOrNull();
  return (
    runnerHost !== null &&
    resolveDesktopMenuPopupBridge(runnerHost) !== null &&
    isWindows()
  );
}
