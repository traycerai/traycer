import { useCallback } from "react";
import { parseHttpUrl } from "@/lib/browser-view/browser-tab-display";
import { isConfigurableLinkKind, type LinkKind } from "@/lib/links/link-kind";
import { useLinkTarget } from "@/lib/links/link-target-context";
import { useOpenBrowserUrl } from "@/lib/links/open-browser-url";
import { useOpenExternalLink } from "@/lib/links/open-external-link";
import type { TileOpenModifiers } from "@/lib/canvas/tile-open/intent";
import {
  linkOpenModeForKind,
  useSettingsStore,
} from "@/stores/settings/settings-store";

/** The parts of a mouse event a link decision reads. `button` 1 is middle. */
export interface LinkClickEvent {
  readonly altKey: boolean;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
  readonly button: number;
}

export type OpenLink = (
  url: string,
  kind: LinkKind,
  event: LinkClickEvent | null,
) => void;

/**
 * The one way a URL leaves the app (A6). Order (A1-A5):
 *
 * 1. a non-http(s) scheme or a hard-external kind goes to the OS browser -
 *    there is nothing a browser tile could do with `mailto:` or an OAuth
 *    device grant;
 * 2. `ctrl`/`meta` forces external, `alt` inverts the configured mode;
 * 3. otherwise the per-kind setting decides, and an in-app open goes through
 *    {@link useOpenBrowserUrl}.
 *
 * Terminal links additionally record their dev-server origin, which is what
 * populates the detected-origins list in settings.
 */
export function useOpenLink(): OpenLink {
  const target = useLinkTarget();
  const openBrowserUrl = useOpenBrowserUrl();
  const openExternalLink = useOpenExternalLink();

  return useCallback(
    (url: string, kind: LinkKind, event: LinkClickEvent | null): void => {
      const trimmed = url.trim();
      const parsed = parseHttpUrl(trimmed);
      if (
        kind === "terminal" &&
        parsed !== null &&
        looksLikeDevServer(parsed)
      ) {
        useSettingsStore.getState().addBrowserDevOrigin(parsed.origin);
      }
      if (parsed === null || !isConfigurableLinkKind(kind)) {
        openExternalLink(trimmed);
        return;
      }
      const webUrl = parsed.href;
      if (event?.ctrlKey === true || event?.metaKey === true) {
        openExternalLink(webUrl);
        return;
      }
      const mode = linkOpenModeForKind(
        useSettingsStore.getState().linkOpen,
        kind,
      );
      // `alt` is consumed here and does NOT also invert tile placement (A3).
      const inApp =
        event?.altKey === true ? mode === "external" : mode === "in-app";
      if (!inApp) {
        openExternalLink(webUrl);
        return;
      }
      if (target === null) {
        // No epic behind this surface at all, so there is no canvas an in-app
        // tab could land on. This is not the A5 failure case (that one toasts
        // in `useOpenBrowserUrl`): nothing was attempted and nothing failed,
        // the surface simply has no in-app destination. Ticket 08 shrinks this
        // set by mounting `LinkTargetProvider` on the surfaces that do.
        openExternalLink(webUrl);
        return;
      }
      openBrowserUrl({
        url: webUrl,
        modifiers: modifiersOf(event),
        epicId: target.epicId,
        viewTabId: target.viewTabId,
      });
    },
    [openBrowserUrl, openExternalLink, target],
  );
}

function modifiersOf(event: LinkClickEvent | null): TileOpenModifiers {
  return {
    shift: event?.shiftKey === true,
    alt: event?.altKey === true,
    middle: event?.button === 1,
  };
}

/** A port or a loopback host is the shape a local dev server takes. */
function looksLikeDevServer(url: URL): boolean {
  if (url.port.length > 0) return true;
  const hostname = url.hostname.toLowerCase();
  return (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.startsWith("127.") ||
    hostname === "0.0.0.0" ||
    hostname === "::1" ||
    hostname === "[::1]"
  );
}
