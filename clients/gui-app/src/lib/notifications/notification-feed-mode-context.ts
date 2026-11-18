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

/**
 * Whether the published mode is a HELD `cloud` whose host is re-negotiating
 * (`useHeldNotificationFeedMode`). Rows keep rendering under the held mode;
 * the operations that SEND the `home: "local"` partition selector on a unary
 * call wait, because the host coming back may be an older release that
 * strips the selector (see the hold's doc). `false` outside the provider:
 * the default mode is `local`, which sends no selector.
 */
export const NotificationFeedModeSettlingContext =
  createContext<boolean>(false);
