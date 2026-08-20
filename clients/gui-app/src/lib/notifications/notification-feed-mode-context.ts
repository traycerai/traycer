import { createContext } from "react";

/**
 * The feed mode `NotificationsSessionProvider` negotiated for the local host.
 *
 * Its own module so the provider file keeps exporting only components, which
 * is what Vite's react-refresh needs to handle HMR cleanly - same reason
 * `use-tab-host-id.ts` is split out from `TabHostProvider`.
 *
 * `local` is the fail-safe default for a consumer rendered outside the
 * provider (tests, isolated stories): it is the single-plane view that cannot
 * double-count replicas.
 */
export const NotificationFeedModeContext = createContext<
  "local" | "cloud" | "upgrade-required"
>("local");
