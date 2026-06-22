import { createFileRoute } from "@tanstack/react-router";
import { requireSignedIn } from "@/lib/router-auth";
import { DraftNewRoute } from "./draft-new-route-components";

export const Route = createFileRoute("/draft/new")({
  beforeLoad: ({ context }) => {
    requireSignedIn(context);
  },
  component: DraftNewRoute,
});
