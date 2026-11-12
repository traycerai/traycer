import { useEffect, useRef } from "react";

/** Label for the waiting-step browser button: "again" only after we opened it. */
export function openBrowserLabel(autoOpen: boolean): string {
  return autoOpen ? "Open browser again" : "Open browser";
}

/**
 * Opens `loginUrl` once per URL when the GUI is the side that should open
 * the browser (`autoOpen`). Returns whether that auto-open ran (or will run)
 * so the button copy can say "again".
 */
export function useAutoOpenLoginUrl(
  autoOpen: boolean,
  loginUrl: string | null,
  onOpen: (url: string) => void,
): boolean {
  const openedUrlRef = useRef<string | null>(null);
  useEffect(() => {
    if (!autoOpen || loginUrl === null) return;
    if (openedUrlRef.current === loginUrl) return;
    openedUrlRef.current = loginUrl;
    onOpen(loginUrl);
  }, [autoOpen, loginUrl, onOpen]);
  return autoOpen;
}
