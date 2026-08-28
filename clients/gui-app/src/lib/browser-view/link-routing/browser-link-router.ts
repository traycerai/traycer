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
          });
        })
        .catch(() => {
          toast.error("Couldn't open the browser tab.");
        });
      return true;
    },
    [sessions],
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
