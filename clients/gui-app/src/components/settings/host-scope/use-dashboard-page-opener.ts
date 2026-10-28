import { ignoreError } from "@/lib/browser-view/ignore-error";
import { useOpenLink, type LinkClickEvent } from "@/lib/links/open-link";
import { useRunnerHostOrNull } from "@/providers/use-runner-host";

/**
 * Opens one of the account's dashboard pages. `page` builds its address from
 * the shell's sign-in origin; with no shell there is no origin to name, so
 * there is nothing to open (`null`).
 */
export function useDashboardPageOpener(
  page: (signInUrl: string) => string,
): ((event: LinkClickEvent) => void) | null {
  const runnerHost = useRunnerHostOrNull();
  const openLink = useOpenLink();
  if (runnerHost === null) return null;
  const url = page(runnerHost.signInUrl);
  return (event) => {
    void openLink(url, "account", event).catch(ignoreError);
  };
}
