import { useEffect, useRef, type RefObject } from "react";

import {
  resolveLiveQuoteSelection,
  type QuoteSelectionSnapshot,
} from "./use-quote-selection";

/**
 * The window event a native shell fires when its own text-selection menu's
 * "Quote" item is tapped. On a phone the selection is built by a long press
 * and handle drag, which raises no `mouseup`, so `useQuoteSelection`'s
 * release-only trigger never arms and the OS edit menu is the affordance
 * instead: WKWebView's edit menu on iOS
 * (`clients/mobile/ios/App/App/QuoteEditMenuWebView.swift`) and the WebView's
 * selection action mode on Android
 * (`clients/mobile/android/.../QuoteActionModeWebView.java`). Both fire this
 * name through Capacitor's window-event trigger; a browser fires it never.
 */
export const NATIVE_QUOTE_REQUEST_EVENT = "traycerQuoteSelection";

/**
 * Answers a native shell's quote request for the transcript under
 * `containerRef`: resolves the LIVE selection through the same rules the
 * popover's snapshot obeys (one quotable root, no streaming tail, no excluded
 * chrome) and hands the result to `onQuote`. A selection that starts outside
 * this container belongs to another chat tile and is left for that tile's
 * instance; one that fails validation is dropped silently - the native menu
 * cannot ask the page whether a selection is quotable before it shows the
 * item, so an unquotable selection simply quotes nothing.
 *
 * Like `useQuoteSelection`, attaches nothing while `enabled` is false.
 */
export function useNativeQuoteRequest(params: {
  readonly containerRef: RefObject<HTMLElement | null>;
  readonly enabled: boolean;
  readonly onQuote: (snapshot: QuoteSelectionSnapshot) => void;
}): void {
  const { containerRef, enabled, onQuote } = params;
  // Latest callback without re-arming the listener per render.
  const onQuoteRef = useRef(onQuote);
  useEffect(() => {
    onQuoteRef.current = onQuote;
  }, [onQuote]);

  useEffect(() => {
    if (!enabled) return;
    const container = containerRef.current;
    if (container === null) return;

    const handleRequest = (): void => {
      const selection = window.getSelection();
      if (selection === null || selection.rangeCount === 0) return;
      if (!container.contains(selection.getRangeAt(0).startContainer)) return;
      const snapshot = resolveLiveQuoteSelection();
      if (snapshot === null) return;
      onQuoteRef.current(snapshot);
    };

    window.addEventListener(NATIVE_QUOTE_REQUEST_EVENT, handleRequest);
    return () => {
      window.removeEventListener(NATIVE_QUOTE_REQUEST_EVENT, handleRequest);
    };
  }, [containerRef, enabled]);
}
