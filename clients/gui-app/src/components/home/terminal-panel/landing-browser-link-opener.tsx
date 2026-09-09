import { useEffect, useRef } from "react";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { v4 as uuidv4 } from "uuid";
import type { RefObject } from "react";
import { browserMutationKeys } from "@/lib/query-keys/browser-mutation-keys";
import {
  useLandingPanelStore,
  type LandingBrowserTabRef,
} from "@/stores/home/landing-panel-store";
import { browserSessionsRefusal } from "@traycer-clients/shared/platform/browser-view";
import type { LandingBrowserSessionEntries } from "./landing-terminal-authority-fleet";
import {
  LANDING_BROWSER_TAB_CAP,
  landingBrowserCapMessage,
  landingBrowserTabCount,
  type LandingBrowserLinkRequest,
} from "./use-landing-browser-open-tab";

/**
 * Dispatches one device's popup queue, one ask at a time.
 *
 * Mounted per device by {@link useLandingBrowserOpenLink}, so each device has
 * its own in-flight open and neither waits on the other.
 */
export function LandingBrowserLinkOpener(props: {
  readonly hostId: string;
  readonly head: LandingBrowserLinkRequest;
  readonly sessionsRef: RefObject<LandingBrowserSessionEntries>;
  readonly onSettled: (hostId: string) => void;
}): null {
  const { hostId, head, sessionsRef, onSettled } = props;
  const dispatchedRef = useRef<string | null>(null);
  const openMutation = useMutation({
    mutationKey: browserMutationKeys.openTab(hostId),
    // The chooser's opener on this device carries the same scope, so the two
    // run one after the other rather than racing the cap re-check.
    scope: { id: browserMutationKeys.openTabScope(hostId) },
    mutationFn: async (
      pending: LandingBrowserLinkRequest,
    ): Promise<LandingBrowserTabRef> => {
      const sessions = sessionsRef.current[pending.hostId] ?? null;
      if (
        sessions === null ||
        sessions.lifecycle !== "live" ||
        !sessions.inventoryReady
      ) {
        throw new Error(browserSessionsRefusal(sessions));
      }
      const tabCount = landingBrowserTabCount(sessions, pending.hostId);
      if (tabCount !== null && tabCount >= LANDING_BROWSER_TAB_CAP) {
        throw new Error(landingBrowserCapMessage());
      }
      const opened = await sessions.openTab(pending.sessionId, pending.url);
      const store = useLandingPanelStore.getState();
      const tab: LandingBrowserTabRef = {
        kind: "browser",
        instanceId: `landing-browser-${uuidv4()}`,
        hostId: pending.hostId,
        sessionId: opened.sessionId,
        tabId: opened.tabId,
        name: pending.url,
        titleSource: "default",
      };
      // Not `addTab`, which activates whatever it adds. A foreground popup
      // may only take a selection the reader has not moved since the ask -
      // the same protection `fulfillPlaceholder` gives the direct open, which
      // page popups were bypassing - and a background one never takes it at
      // all, so the strip is written once rather than activated and put back.
      //
      // The revision rides on the request from where the page raised it. Not
      // read here: this runs when the ask reaches the head of its device's
      // queue, which is after any popup ahead of it has landed and after
      // anything the reader did in the meantime.
      store.addPageOpenedTab(tab, {
        foreground: pending.disposition === "foreground",
        selectionRevision: pending.selectionRevision,
      });
      return tab;
    },
    onError: (cause: Error) => {
      toast.error(cause.message);
    },
    onSettled: () => {
      onSettled(hostId);
    },
  });
  const mutate = openMutation.mutate;
  useEffect(() => {
    if (dispatchedRef.current === head.requestId) return;
    dispatchedRef.current = head.requestId;
    mutate(head);
  }, [mutate, head]);
  return null;
}
