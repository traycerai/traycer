import * as React from "react";
import {
  MOBILE_PHONE_PORTRAIT_WIDTH_LIMIT_PX,
  resolveMobileLayoutForm,
  type MobileLayoutForm,
  type MobileTileCount,
} from "@/lib/layout/mobile-layout-form";
import {
  readSafeAreaInsets,
  subscribeToSafeAreaInsets,
} from "@/lib/safe-area-insets";
import { useSideStripCollapsed } from "@/stores/layout/side-tab-strip-store";

const PHONE_WIDTH_QUERY = `(width < ${MOBILE_PHONE_PORTRAIT_WIDTH_LIMIT_PX}px)`;

/** Absent on iOS before 16.4, whatever the DOM types say. */
function readScreenOrientation(): ScreenOrientation | null {
  return "orientation" in window.screen ? window.screen.orientation : null;
}

function subscribeToPhonePortrait(onChange: () => void): () => void {
  const mql = window.matchMedia(PHONE_WIDTH_QUERY);
  mql.addEventListener("change", onChange);
  // The same self-heal as `use-narrow-window.ts`: a `change` WKWebView drops
  // cannot wedge the form, because the resize accompanying it re-asks.
  window.addEventListener("resize", onChange);
  const orientation = readScreenOrientation();
  orientation?.addEventListener("change", onChange);
  return () => {
    mql.removeEventListener("change", onChange);
    window.removeEventListener("resize", onChange);
    orientation?.removeEventListener("change", onChange);
  };
}

/**
 * The SCREEN, not the viewport's shape: Android resizes the viewport for the
 * keyboard, so `(orientation: portrait)` would flip a portrait phone to
 * landscape while the person types, moving the navigation under them.
 *
 * iOS before 16.4 has no `screen.orientation`, and its `screen` keeps its
 * portrait dimensions in every orientation. That reads as portrait throughout,
 * which the width half corrects: no phone there is under the limit on its side.
 */
function readScreenPortrait(): boolean {
  const orientation = readScreenOrientation();
  if (orientation !== null) return orientation.type.startsWith("portrait");
  return window.screen.width < window.screen.height;
}

/** The width reads the query for the reason `use-narrow-window.ts` records: `innerWidth` settles late. */
function readPhonePortrait(): boolean {
  return readScreenPortrait() && window.matchMedia(PHONE_WIDTH_QUERY).matches;
}

function readPhonePortraitServerSnapshot(): boolean {
  return false;
}

/**
 * `#root`, not the element the tiles render into: `#root`'s padding is the
 * safe-area reservation, so its content box is the insets and any Split View
 * already taken off, and it does not move when level 1 mounts. The tiles'
 * element shrinks by the strip the answer draws, so measuring it would feed
 * each answer back into the next.
 */
function subscribeToShellContentWidth(onChange: () => void): () => void {
  const root = document.getElementById("root");
  if (root === null) return () => {};
  const observer = new ResizeObserver(onChange);
  observer.observe(root);
  // A rotation moves the insets as well as the box.
  const unsubscribeInsets = subscribeToSafeAreaInsets(onChange);
  return () => {
    observer.disconnect();
    unsubscribeInsets();
  };
}

function readShellContentWidth(): number {
  const root = document.getElementById("root");
  if (root === null) return 0;
  const insets = readSafeAreaInsets();
  return root.getBoundingClientRect().width - insets.left - insets.right;
}

function readShellContentWidthServerSnapshot(): number {
  return 0;
}

/**
 * The form the phone shell draws right now, with `openTiles` open. A surface
 * that needs to know whether a second tile would fit asks with 2.
 */
export function useMobileLayoutForm(
  openTiles: MobileTileCount,
): MobileLayoutForm {
  const contentWidth = React.useSyncExternalStore(
    subscribeToShellContentWidth,
    readShellContentWidth,
    readShellContentWidthServerSnapshot,
  );
  const phonePortrait = React.useSyncExternalStore(
    subscribeToPhonePortrait,
    readPhonePortrait,
    readPhonePortraitServerSnapshot,
  );
  const collapsed = useSideStripCollapsed();
  return resolveMobileLayoutForm({
    contentWidth,
    phonePortrait,
    stripPreference: collapsed ? "rail" : "expanded",
    openTiles,
  });
}
