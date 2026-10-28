import { createFileRoute, redirect } from "@tanstack/react-router";

/**
 * Legacy redirect: Browser agent access is the Browser tab of Permissions. A
 * remembered path or a deep link lands on that page.
 */
export const Route = createFileRoute("/settings/browser-agent-access")({
  beforeLoad: () => {
    redirect({ throw: true, to: "/settings/permissions", replace: true });
  },
});
