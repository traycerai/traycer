import { createFileRoute, redirect } from "@tanstack/react-router";
import { requireSignedIn } from "@/lib/router-auth";
import { UNRELEASED_FEATURES_ENABLED } from "@/unreleased-features";

/**
 * The Tracy surface with no channel selected (decision 150): the pane says
 * bots are created from Home. The tab-kind descriptor renders the surface
 * once inside `TopLevelTabHost`, as for `/bot/$botId`.
 */
export const Route = createFileRoute("/bot/")({
  beforeLoad: ({ context }) => {
    // Not a page of a build without bots: a deep link lands on Home.
    if (!UNRELEASED_FEATURES_ENABLED) {
      redirect({ throw: true, to: "/", replace: true });
    }
    requireSignedIn(context);
  },
  component: () => null,
});
