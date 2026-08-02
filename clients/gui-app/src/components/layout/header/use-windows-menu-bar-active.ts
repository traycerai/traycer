import { isWindows } from "@/lib/keybindings/platform";
import { resolveDesktopMenuPopupBridge } from "@/lib/windows/desktop-capabilities";
import { useRunnerHostOrNull } from "@/providers/use-runner-host";

/**
 * Whether the Windows frameless menu strip renders at all: only on a Windows
 * desktop shell whose bridge can pop up native submenus. Containers that
 * reserve title-bar space for the strip gate on this too, so they collapse on
 * macOS / Linux / web exactly when the strip itself does.
 */
export function useWindowsMenuBarActive(): boolean {
  const runnerHost = useRunnerHostOrNull();
  return (
    runnerHost !== null &&
    resolveDesktopMenuPopupBridge(runnerHost) !== null &&
    isWindows()
  );
}
