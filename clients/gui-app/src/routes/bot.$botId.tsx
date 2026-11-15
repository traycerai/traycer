import { createFileRoute } from "@tanstack/react-router";
import { normalizeTracyPlaceSearch } from "@/lib/bots/tracy-place";
import { requireSignedIn } from "@/lib/router-auth";
import { TracyChannelPlaceRoute } from "./tracy-route-components";

/**
 * A channel of the Tracy surface (decision 150), deep-linkable. The tab-kind
 * descriptor renders the surface once inside `TopLevelTabHost`, the way
 * `/sample-workspace` does; the navigation controller resolves the path to
 * the surface's one ref, opening it on this window's host when it is closed,
 * and selects the channel.
 */
export const Route = createFileRoute("/bot/$botId")({
  validateSearch: (search: Record<string, unknown>) =>
    normalizeTracyPlaceSearch(search),
  beforeLoad: ({ context }) => {
    requireSignedIn(context);
  },
  component: TracyChannelPlaceRoute,
});
