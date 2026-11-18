import { createFileRoute, redirect } from "@tanstack/react-router";
import { requireSignedIn } from "@/lib/router-auth";
import { isMobileViewport } from "@/hooks/ui/use-mobile-viewport";

export const Route = createFileRoute("/sample-workspace")({
  beforeLoad: ({ context }) => {
    requireSignedIn(context);
    if (isMobileViewport()) redirect({ to: "/", replace: true, throw: true });
  },
  // The descriptor renders the body once inside TopLevelTabHost.
  component: () => null,
});
