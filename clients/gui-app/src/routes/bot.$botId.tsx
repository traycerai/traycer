import { createFileRoute } from "@tanstack/react-router";
import { requireSignedIn } from "@/lib/router-auth";

/**
 * A channel of the Tracy surface (decision 150), deep-linkable. The tab-kind
 * descriptor renders the surface once inside `TopLevelTabHost`, the way
 * `/sample-workspace` does; the navigation controller resolves the path to
 * the surface's one ref, opening it on this window's host when it is closed,
 * and selects the channel.
 */
export const Route = createFileRoute("/bot/$botId")({
  beforeLoad: ({ context }) => {
    requireSignedIn(context);
  },
  component: () => null,
});
