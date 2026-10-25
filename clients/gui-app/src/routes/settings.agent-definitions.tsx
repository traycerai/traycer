import { createFileRoute, redirect } from "@tanstack/react-router";

/**
 * Legacy redirect: agent definitions are the Agents page's Definitions tab.
 * A remembered path or a deep link lands on that page.
 */
export const Route = createFileRoute("/settings/agent-definitions")({
  beforeLoad: () => {
    redirect({ throw: true, to: "/settings/agents", replace: true });
  },
});
