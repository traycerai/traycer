import { createFileRoute, redirect } from "@tanstack/react-router";

/**
 * Legacy redirect: the host's Notifications page held notification hooks,
 * which are removed; what is left to set about notifications is which kinds
 * interrupt this device, on Alerts. A remembered path or a deep link lands
 * there.
 */
export const Route = createFileRoute("/settings/notifications")({
  beforeLoad: () => {
    redirect({ throw: true, to: "/settings/alerts", replace: true });
  },
});
