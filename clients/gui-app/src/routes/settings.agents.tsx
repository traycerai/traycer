import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/settings/agents")({
  beforeLoad: () => {
    redirect({ throw: true, to: "/settings/providers", replace: true });
  },
});
