import { use, useCallback } from "react";
import { toast } from "sonner";
import type { IRunnerHost } from "@traycer-clients/shared/platform/runner-host";
import {
  routeBrowserLink,
  openBrowserSessionTileFromPage,
  type BrowserLinkClickEvent,
  type BrowserLinkKind,
  type BrowserLinkOpenResult,
  type BrowserLinkSource,
} from "@/lib/browser-view/link-routing/browser-link-routing-core";
import { BrowserLinkRoutingContext } from "@/lib/browser-view/link-routing/browser-link-routing-context";
import { RunnerHostContext } from "@/providers/runner-host-context";
import { useMaybeBrowserSessionsContext } from "@/components/epic-canvas/renderers/browser-sessions-context";
import { useIsMobileViewport } from "@/hooks/ui/use-mobile-viewport";

export function useBrowserLinkRouter(): (
  kind: BrowserLinkKind,
  url: string,
  event: BrowserLinkClickEvent | null,
) => BrowserLinkOpenResult {
  return useBrowserLinkRouterForRunnerHost(useRunnerHostForBrowserLinks());
}

export function useBrowserLinkRouterForRunnerHost(
  runnerHost: Pick<IRunnerHost, "openExternalLink">,
): (
  kind: BrowserLinkKind,
  url: string,
  event: BrowserLinkClickEvent | null,
) => BrowserLinkOpenResult {
  const context = use(BrowserLinkRoutingContext);
  const sessions = useMaybeBrowserSessionsContext();
  const singleTileViewport = useIsMobileViewport();
  const openInApp = useCallback(
    (source: BrowserLinkSource, url: string): boolean => {
      if (
        sessions === null ||
        sessions.lifecycle !== "live" ||
        sessions.hostId !== source.hostId
      ) {
        return false;
      }
      void sessions
        .openTab(null, url)
        .then((opened) => {
          openBrowserSessionTileFromPage({
            ...source,
            ...opened,
            url,
            placement: singleTileViewport ? "same-pane" : "split-right",
          });
        })
        .catch(() => {
          // The answer is committed before the host round trip settles - the
          // click has to be handled in its own turn - so a refusal cannot be
          // reported by returning false any more. Sending the link where it
          // would have gone had the session never been live keeps a failed
          // open from swallowing the navigation outright.
          toast.error(
            "Couldn't open the browser tab. Opened it outside Traycer instead.",
          );
          void runnerHost.openExternalLink(url);
        });
      return true;
    },
    [runnerHost, sessions, singleTileViewport],
  );
  return useCallback(
    (kind, url, event) =>
      routeBrowserLink({
        runnerHost,
        source: context?.source ?? null,
        kind,
        url,
        event,
        openInApp,
      }),
    [context?.source, openInApp, runnerHost],
  );
}

function useRunnerHostForBrowserLinks(): Pick<IRunnerHost, "openExternalLink"> {
  const runnerHost = use(RunnerHostContext);
  if (runnerHost !== null) return runnerHost;
  return {
    openExternalLink: () => Promise.resolve(),
  };
}
