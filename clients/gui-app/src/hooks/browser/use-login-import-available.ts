import { useBrowserSaveLoginsEnabled } from "@/lib/browser-view/use-browser-save-logins";
import { useRunnerHostOrNull } from "@/providers/use-runner-host";

/**
 * Whether this machine can import logins right now: a desktop with a browser
 * bridge, and saving logins turned on.
 *
 * The second half matters as much as the first. Settings' import row is
 * DISABLED with saving off - the import writes the durable jar, which is not
 * the one the tiles are on then - so a surface that offered the import
 * anyway (the tour's act, the announcement toast) would be offering what the
 * row refuses. Web and mobile have no bridge and so no jar to import into.
 *
 * `null` (the pref not read yet, or unreadable) is "not available", not
 * "unknown": the act and the toast are additions, and a tour that gains an
 * act a moment after mounting is a smaller wrong than one that offers an
 * import the machine then refuses.
 */
export function useLoginImportAvailable(): boolean {
  const browserView = useRunnerHostOrNull()?.browserView ?? null;
  const enabled = useBrowserSaveLoginsEnabled(browserView);
  return browserView !== null && enabled === true;
}
