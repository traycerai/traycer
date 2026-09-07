import { createFileRoute } from "@tanstack/react-router";
import { DraftRoute } from "./draft-route-components";

/**
 * Deep-link `/draft/$draftId`. Activate in a committed effect; `hasHydrated` blocks a cold-load redirect.
 */
export const Route = createFileRoute("/draft/$draftId")({
  component: DraftRoute,
});
