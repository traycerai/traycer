import { createContext, use } from "react";

export const TabHostContext = createContext<string | null>(null);

/**
 * Returns the host id the surrounding tile is bound to. Throws when
 * called outside `<TabHostProvider>` - consumers that legitimately need the
 * canvas-serving host must use `useCanvasHostId()` instead.
 *
 * Kept in its own module (separate from `TabHostProvider`) so the
 * provider file exports only the component - required for Vite's
 * react-refresh to handle HMR cleanly.
 */
export function useTabHostId(): string {
  const value = use(TabHostContext);
  if (value === null) {
    throw new Error(
      "useTabHostId must be called inside <TabHostProvider>. Tile renderers are wrapped automatically by epic-canvas/renderers/index.tsx; if you need the canvas-serving host, use useCanvasHostId().",
    );
  }
  return value;
}

/**
 * The tab's host id, or `null` when there is no `<TabHostProvider>` above.
 *
 * The tolerant read (the shape `useMaybeOpenEpicHandle` /
 * `useMaybeEpicPermissionRole` already use) for a hook that is mounted on
 * every render but only USED for some inputs - `useFileBytes` mounts all four
 * of its byte legs unconditionally so the hook order cannot shift under a
 * source change, and two of those legs need a tab host while the chat
 * attachment leg is provider-free by design. Reach for this only where the
 * absence is a real, handled state; a tile renderer that genuinely requires
 * its host must keep using {@link useTabHostId} and its loud error.
 */
export function useMaybeTabHostId(): string | null {
  return use(TabHostContext);
}
