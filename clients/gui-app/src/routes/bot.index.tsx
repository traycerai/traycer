import { createFileRoute } from "@tanstack/react-router";
import { normalizeTracyPlaceSearch } from "@/lib/bots/tracy-place";
import { requireSignedIn } from "@/lib/router-auth";
import { TracySurfacePlaceRoute } from "./tracy-route-components";

/**
 * The Tracy surface with no channel selected (decision 150): the pane says
 * bots are created from Home. The tab-kind descriptor renders the surface
 * once inside `TopLevelTabHost`, as for `/bot/$botId`.
 */
export const Route = createFileRoute("/bot/")({
  validateSearch: (search: Record<string, unknown>) =>
    normalizeTracyPlaceSearch(search),
  beforeLoad: ({ context }) => {
    requireSignedIn(context);
  },
  component: TracySurfacePlaceRoute,
});
