import { createContext, use } from "react";

export const TabHostContext = createContext<string | null>(null);

/**
 * Returns the host id the surrounding tile is bound to. Throws when
 * called outside `<TabHostProvider>` - consumers that legitimately
 * need the renderer-default host must use
 * `useReactiveActiveHostId()` instead.
 *
 * Kept in its own module (separate from `TabHostProvider`) so the
 * provider file exports only the component - required for Vite's
 * react-refresh to handle HMR cleanly.
 */
export function useTabHostId(): string {
  const value = use(TabHostContext);
  if (value === null) {
    throw new Error(
      "useTabHostId must be called inside <TabHostProvider>. Tile renderers are wrapped automatically by epic-canvas/renderers/index.tsx; if you need the renderer-default host, use useReactiveActiveHostId().",
    );
  }
  return value;
}
