import { useBrowserSaveLoginsEnabled } from "@/lib/browser-view/use-browser-save-logins";
import { useRunnerHostOrNull } from "@/providers/use-runner-host";

/**
 * Desktop with a browser bridge and saving logins on. `null` (pref unread) is not available, not unknown.
 */
export function useLoginImportAvailable(): boolean {
  const browserView = useRunnerHostOrNull()?.browserView ?? null;
  const enabled = useBrowserSaveLoginsEnabled(browserView);
  return browserView !== null && enabled === true;
}
