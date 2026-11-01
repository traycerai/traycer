import { createFileRoute, redirect } from "@tanstack/react-router";
import { requireSignedIn } from "@/lib/router-auth";
import { UNRELEASED_FEATURES_ENABLED } from "@/unreleased-features";

/**
 * A channel of the Tracy surface (decision 150), deep-linkable. The tab-kind
 * descriptor renders the surface once inside `TopLevelTabHost`, the way
 * `/sample-workspace` does; the navigation controller resolves the path to
 * the surface's one ref, opening it on this window's host when it is closed,
 * and selects the channel.
 */
export const Route = createFileRoute("/bot/$botId")({
  beforeLoad: ({ context }) => {
    // Not a page of a build without bots: a deep link lands on Home.
    if (!UNRELEASED_FEATURES_ENABLED) {
      redirect({ throw: true, to: "/", replace: true });
    }
    requireSignedIn(context);
  },
  component: () => null,
});
