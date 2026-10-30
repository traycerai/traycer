import { createFileRoute, redirect } from "@tanstack/react-router";
import { requireSignedIn } from "@/lib/router-auth";
import { UNRELEASED_FEATURES_ENABLED } from "@/unreleased-features";

/**
 * Deep-linkable per-bot route (Tracy Bots). The tab-kind descriptor renders
 * the body once inside `TopLevelTabHost`, the way `/sample-workspace` does;
 * the navigation controller resolves the path to the bot tab's ref and
 * corrects to the landing route when no bot tab record exists for the id
 * (the record carries the host the tab is bound to, and a bare url cannot
 * name one).
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
