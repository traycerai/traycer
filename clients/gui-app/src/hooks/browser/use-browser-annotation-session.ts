import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

import { useAnnotationRoute } from "@/hooks/browser/use-annotation-route";
import { attachBrowserAnnotation } from "@/lib/browser-view/annotation/browser-annotation-attach";
import { browserViewTileKeyId } from "@/lib/browser-view/tiles/browser-view-keys";
import { resolveCssColor } from "@/lib/css-color";
import { ignoreError } from "@/lib/browser-view/ignore-error";
import { getResolvedTheme } from "@/lib/theme-applier";
import type {
  BrowserAnnotationAttachedIpcEvent,
  BrowserAnnotationSessionIpcEvent,
  BrowserAnnotationTheme,
} from "@traycer-clients/shared/platform/browser-annotation";
import type {
  BrowserViewBridge,
  BrowserViewStatus,
  BrowserViewTileKey,
} from "@traycer-clients/shared/platform/browser-view";

export interface BrowserAnnotationSessionController {
  readonly isActive: boolean;
  readonly canStart: boolean;
  readonly zoomLocked: boolean;
  readonly toggle: () => void;
}

interface UseBrowserAnnotationSessionArgs {
  readonly browserView: BrowserViewBridge | null;
  readonly tileKey: BrowserViewTileKey;
  readonly status: BrowserViewStatus;
  readonly epicId: string;
  readonly browserHostId: string;
  readonly preferredChatId: string | null;
  readonly fallbackChatId: string | null;
}

/**
 * Starts/cancels the native annotation overlay, routes attach payloads into
 * the selected composer, and pushes live target choices while a session is open.
 */
export function useBrowserAnnotationSession(
  args: UseBrowserAnnotationSessionArgs,
): BrowserAnnotationSessionController {
  const { browserView, tileKey, status } = args;
  const route = useAnnotationRoute({
    epicId: args.epicId,
    tileInstanceId: tileKey.tileInstanceId,
    browserHostId: args.browserHostId,
    preferredChatId: args.preferredChatId,
    fallbackChatId: args.fallbackChatId,
  });
  const [isActive, setIsActive] = useState(false);
  const [markCount, setMarkCount] = useState(0);
  const canStart = browserView !== null && status === "ready";

  useEffect(() => {
    if (browserView === null) return;
    return () => {
      void browserView.cancelAnnotation(tileKey).catch(ignoreError);
    };
  }, [browserView, tileKey]);

  useEffect(() => {
    if (browserView === null) return;
    const subscription = browserView.onAnnotationEvent((change) => {
      if (!isEventForTile(change, tileKey)) return;
      applySessionEvent(change, setIsActive, setMarkCount);
    });
    return () => {
      subscription.dispose();
    };
  }, [browserView, tileKey]);

  useEffect(() => {
    if (browserView === null) return;
    const subscription = browserView.onAnnotationAttached((change) => {
      if (!isEventForTile(change, tileKey)) return;
      void ingestAttachedAnnotation(change, (input) =>
        browserView.reportAnnotationAttachResult(input),
      );
    });
    return () => {
      subscription.dispose();
    };
  }, [browserView, tileKey]);

  useEffect(() => {
    if (browserView === null || !isActive) return;
    void browserView
      .setAnnotationTargetChatLabel({
        ...tileKey,
        targets: route.targets,
        defaultChatId: route.defaultChatId,
      })
      .catch(ignoreError);
  }, [browserView, isActive, route, tileKey]);

  const start = useCallback(() => {
    if (browserView === null || status !== "ready") return;
    void browserView
      .startAnnotation({
        ...tileKey,
        theme: buildBrowserAnnotationTheme(document),
      })
      .then((result) => {
        if (!result.ok) {
          toast.error("Couldn't start annotation.", {
            description: result.reason,
          });
          return;
        }
        setIsActive(true);
        setMarkCount(0);
      })
      .catch(() => {
        toast.error("Couldn't start annotation.");
      });
  }, [browserView, status, tileKey]);

  const cancel = useCallback(() => {
    setIsActive(false);
    setMarkCount(0);
    if (browserView === null) return;
    void browserView.cancelAnnotation(tileKey).catch(ignoreError);
  }, [browserView, tileKey]);

  const toggle = useCallback(() => {
    if (isActive) {
      cancel();
      return;
    }
    start();
  }, [isActive, cancel, start]);

  return {
    isActive,
    canStart,
    zoomLocked: isActive && markCount > 0,
    toggle,
  };
}

function buildBrowserAnnotationTheme(doc: Document): BrowserAnnotationTheme {
  const appearance = getResolvedTheme();
  const dark = appearance === "dark";
  const background = dark ? "#292929" : "#fafafa";
  const foreground = dark ? "#fafafa" : "#252525";
  const rootStyle = getComputedStyle(doc.documentElement);
  return {
    appearance,
    background: resolveCssColor(doc, "--background", background),
    foreground: resolveCssColor(doc, "--foreground", foreground),
    popover: resolveCssColor(doc, "--popover", background),
    popoverForeground: resolveCssColor(doc, "--popover-foreground", foreground),
    mutedForeground: resolveCssColor(
      doc,
      "--muted-foreground",
      dark ? "#a3a3a3" : "#737373",
    ),
    border: resolveCssColor(doc, "--border", dark ? "#ffffff1a" : "#e5e5e5"),
    input: resolveCssColor(doc, "--input", dark ? "#ffffff26" : "#e5e5e5"),
    ring: resolveCssColor(doc, "--ring", dark ? "#737373" : "#a3a3a3"),
    primary: resolveCssColor(doc, "--primary", foreground),
    primaryForeground: resolveCssColor(doc, "--primary-foreground", background),
    accent: resolveCssColor(doc, "--accent", dark ? "#404040" : "#f5f5f5"),
    accentForeground: resolveCssColor(doc, "--accent-foreground", foreground),
    destructive: resolveCssColor(
      doc,
      "--destructive",
      dark ? "#f87171" : "#dc2626",
    ),
    warning: resolveCssColor(doc, "--warning", dark ? "#fbbf24" : "#d97706"),
    warningForeground: resolveCssColor(
      doc,
      "--warning-foreground",
      dark ? "#fde68a" : "#78350f",
    ),
    fontFamily:
      rootStyle.fontFamily.trim() ||
      "-apple-system, BlinkMacSystemFont, sans-serif",
  };
}

function applySessionEvent(
  change: BrowserAnnotationSessionIpcEvent,
  setIsActive: (value: boolean) => void,
  setMarkCount: (value: number) => void,
): void {
  if (change.event.type === "stateChanged") {
    setMarkCount(change.event.markCount);
    return;
  }
  setIsActive(false);
  setMarkCount(0);
}

async function ingestAttachedAnnotation(
  change: BrowserAnnotationAttachedIpcEvent,
  reportResult: BrowserViewBridge["reportAnnotationAttachResult"],
): Promise<void> {
  const annotationId = change.payload.annotationId;
  let status: "attached" | "failed" = "failed";
  try {
    const result = await attachBrowserAnnotation({
      chatId: change.targetChatId,
      payload: change.payload,
      png: change.pngBytes,
    });
    if (result.status === "attached") {
      status = "attached";
    } else {
      toast.error("Couldn't store the annotation crop.");
    }
  } catch {
    // Same surface as a rejected store: the crop is gone either way, and an
    // uncaught throw here escaped the `void`-ed promise as an unhandled
    // rejection after the tile had already been told "failed".
    toast.error("Couldn't store the annotation crop.");
  } finally {
    void reportResult({ annotationId, status }).catch(ignoreError);
  }
}

function isEventForTile(
  change: BrowserViewTileKey,
  key: BrowserViewTileKey,
): boolean {
  return browserViewTileKeyId(change) === browserViewTileKeyId(key);
}
