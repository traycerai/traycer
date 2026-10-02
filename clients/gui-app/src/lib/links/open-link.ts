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
) => Promise<void>;

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
 *
 * The returned promise settles with the OS handoff and REJECTS when it fails,
 * for the one caller that needs to know (the report-issue publish flow keeps
 * its preview screen on a failed open, L1). The in-app path resolves
 * immediately - it has already handed off to `openBrowserUrl`, which owns its
 * own failure toast (A5). Nothing needs to await it: the bridge promise
 * carries its own rejection handler (see {@link useOpenLinkWithPending}), so a
 * plain `void openLink(...)` is safe.
 */
export function useOpenLink(): OpenLink {
  return useOpenLinkWithPending().openLink;
}

export interface OpenLinkWithPending {
  readonly openLink: OpenLink;
  /**
   * True while an OS handoff started through THIS hook is outstanding - the
   * bridge mutation's own `isPending`. Drives `disabled` / `aria-disabled` on
   * the surfaces where a second click would open the browser twice (R10).
   */
  readonly isPending: boolean;
}

/**
 * {@link useOpenLink} plus the bridge mutation's pending flag, for the few
 * surfaces that render a pending state. Everything else takes the function
 * alone.
 */
export function useOpenLinkWithPending(): OpenLinkWithPending {
  const { openWebUrlIn, openInOsBrowser, isPending } = useLinkOpeners();

  const openLink = useCallback(
    (
      url: string,
      kind: LinkKind,
      event: LinkClickEvent | null,
    ): Promise<void> => {
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
        return openInOsBrowser(trimmed);
      }
      if (event?.ctrlKey === true || event?.metaKey === true) {
        return openInOsBrowser(parsed.href);
      }
      const mode = linkOpenModeForKind(
        useSettingsStore.getState().linkOpen,
        kind,
      );
      // `alt` is consumed here and does NOT also invert tile placement (A3).
      const inApp =
        event?.altKey === true ? mode === "external" : mode === "in-app";
      return openWebUrlIn(
        parsed.href,
        inApp ? "in-app" : "external",
        modifiersOf(event),
      );
    },
    [openInOsBrowser, openWebUrlIn],
  );

  return { isPending, openLink };
}

/** Where a link the user aimed explicitly should open. */
export type LinkDestination = "in-app" | "external";

export interface OpenLinkIn {
  /**
   * Opens `url` where the user asked, skipping the per-kind setting and the
   * click modifiers - for a gesture that already names its destination, like
   * a link's right-click menu. A non-http(s) URL always goes to the OS.
   */
  readonly openLinkIn: (url: string, destination: LinkDestination) => void;
  /**
   * False where no canvas is behind the surface, so an in-app open would land
   * in the OS browser anyway and offering it as a separate choice would lie.
   */
  readonly canOpenInApp: boolean;
}

export function useOpenLinkIn(): OpenLinkIn {
  const { openWebUrlIn, openInOsBrowser, canOpenInApp } = useLinkOpeners();

  const openLinkIn = useCallback(
    (url: string, destination: LinkDestination): void => {
      const trimmed = url.trim();
      const parsed = parseHttpUrl(trimmed);
      if (parsed === null) {
        void openInOsBrowser(trimmed);
        return;
      }
      void openWebUrlIn(parsed.href, destination, NO_MODIFIERS);
    },
    [openInOsBrowser, openWebUrlIn],
  );

  return { openLinkIn, canOpenInApp };
}

const NO_MODIFIERS: TileOpenModifiers = {
  shift: false,
  alt: false,
  middle: false,
};

interface LinkOpeners {
  /** Hands `href` to the OS browser; rejects when the handoff fails (L1). */
  readonly openInOsBrowser: (href: string) => Promise<void>;
  /** Opens an already-parsed http(s) URL at a decided destination. */
  readonly openWebUrlIn: (
    webUrl: string,
    destination: LinkDestination,
    modifiers: TileOpenModifiers,
  ) => Promise<void>;
  readonly canOpenInApp: boolean;
  readonly isPending: boolean;
}

/**
 * The two ends every link open reaches once its destination is decided,
 * shared by the setting-driven click path and the explicit menu path so both
 * land a link the same way.
 */
function useLinkOpeners(): LinkOpeners {
  const target = useLinkTarget();
  const openBrowserUrl = useOpenBrowserUrl();
  const { isPending, mutateAsync } = useOpenExternalLink();

  // Most callers fire and forget, so an unhandled rejection would be the
  // NORMAL case. The handler is attached to THIS promise rather than a
  // derived copy, so a caller that awaits still sees the failure - which is
  // what keeps the report-issue publish flow on its preview screen instead of
  // advancing to the confirmation (L1).
  const openInOsBrowser = useCallback(
    (href: string): Promise<void> => {
      const done = mutateAsync(href);
      void done.catch(() => undefined);
      return done;
    },
    [mutateAsync],
  );

  const openWebUrlIn = useCallback(
    (
      webUrl: string,
      destination: LinkDestination,
      modifiers: TileOpenModifiers,
    ): Promise<void> => {
      if (destination === "external") return openInOsBrowser(webUrl);
      if (target === null) {
        // No epic behind this surface at all, so there is no canvas an in-app
        // tab could land on. This is not the A5 failure case (that one toasts
        // in `useOpenBrowserUrl`): nothing was attempted and nothing failed,
        // the surface simply has no in-app destination. Ticket 08 shrinks this
        // set by mounting `LinkTargetProvider` on the surfaces that do.
        return openInOsBrowser(webUrl);
      }
      openBrowserUrl({
        url: webUrl,
        modifiers,
        epicId: target.epicId,
        viewTabId: target.viewTabId,
      });
      return Promise.resolve();
    },
    [openBrowserUrl, openInOsBrowser, target],
  );

  return {
    openInOsBrowser,
    openWebUrlIn,
    canOpenInApp: target !== null,
    isPending,
  };
}

function modifiersOf(event: LinkClickEvent | null): TileOpenModifiers {
  return {
    shift: event?.shiftKey === true,
    // `alt` was already consumed above to invert in-app/external (A3), so it
    // must NOT reach the tile intent and invert tab<->split as well.
    alt: false,
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
