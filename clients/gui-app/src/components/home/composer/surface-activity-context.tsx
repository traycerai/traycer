import { use, type ReactNode } from "react";
import { SurfaceActivityContext } from "@/components/home/composer/surface-activity-context-internal";

/**
 * Scopes composer-surface activity for query gating (harness catalog,
 * providers list, model lists). Consumers read it via `useSurfaceActivity()`
 * instead of threading an `activityEnabled` prop through every toolbar layer.
 *
 * Providers COMPOSE: a nested provider can only narrow activity, never widen
 * it past its parent (e.g. the landing surface provides "home page not
 * occluded by a system modal", and the chat/terminal panes nest "my pane is
 * the visible composer mode" inside it).
 */
export function SurfaceActivityProvider(props: {
  readonly active: boolean;
  readonly children: ReactNode;
}) {
  const parentActive = use(SurfaceActivityContext);
  const active = parentActive ? props.active : false;
  return (
    <SurfaceActivityContext.Provider value={active}>
      {props.children}
    </SurfaceActivityContext.Provider>
  );
}
