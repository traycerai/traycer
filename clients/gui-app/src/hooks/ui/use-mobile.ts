import * as React from "react";

const MOBILE_BREAKPOINT = 768;
const MOBILE_QUERY = `(max-width: ${MOBILE_BREAKPOINT - 1}px)`;

function subscribeToMobileQuery(onChange: () => void): () => void {
  const mql = window.matchMedia(MOBILE_QUERY);
  mql.addEventListener("change", onChange);
  return () => mql.removeEventListener("change", onChange);
}

function readIsMobileSnapshot(): boolean {
  return window.innerWidth < MOBILE_BREAKPOINT;
}

function readIsMobileServerSnapshot(): boolean {
  return false;
}

export function useIsMobile(): boolean {
  return React.useSyncExternalStore(
    subscribeToMobileQuery,
    readIsMobileSnapshot,
    readIsMobileServerSnapshot,
  );
}
