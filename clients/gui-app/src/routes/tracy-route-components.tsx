import type { ReactNode } from "react";
import { useParams } from "@tanstack/react-router";
import { useTracyPlaceRoute } from "@/hooks/bots/use-tracy-place-route";

/**
 * What a Tracy route mounts: nothing to draw (the tab-kind descriptor renders
 * the surface), only the keeping of the route's place in step with it. Mounted
 * exactly while the window's location is the surface's, which is the only
 * time the surface has a route to record its place on.
 */
function TracyPlaceRoute(props: { readonly botId: string | null }): ReactNode {
  useTracyPlaceRoute(props.botId);
  return null;
}

/** `/bot/{botId}`: the surface on a channel. */
export function TracyChannelPlaceRoute(): ReactNode {
  const { botId } = useParams({ from: "/bot/$botId" });
  return <TracyPlaceRoute botId={botId} />;
}

/** `/bot`: the surface with no channel selected. */
export function TracySurfacePlaceRoute(): ReactNode {
  return <TracyPlaceRoute botId={null} />;
}
