import { createFileRoute } from "@tanstack/react-router";
import { DraftRoute } from "./draft-route-components";

/**
 * Deep-linkable per-draft route. Activates the draft identified in the URL
 * via a committed effect (route preloading must not mutate UI/client state
 * per the gui-app `AGENTS.md` rule), then renders the same landing surface
 * `/` uses. The `hasHydrated` gate prevents a spurious redirect on desktop
 * where the per-window draft snapshot arrives asynchronously after first
 * render - without it, a cold load at `/draft/{id}` would see an empty
 * store, redirect to `/`, then the snapshot would arrive too late.
 */
export const Route = createFileRoute("/draft/$draftId")({
  component: DraftRoute,
});
