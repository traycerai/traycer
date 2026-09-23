import { createFileRoute } from "@tanstack/react-router";
import { requireSignedIn } from "@/lib/router-auth";
import { IdentityRoute } from "./identities-route-components";

/**
 * Deep-linkable per-identity route. Like `/draft/$draftId`, the route itself
 * renders nothing: `TabNavigationController` resolves the location to an
 * `identity` tab (opening one on the effective host when none exists) and
 * `TopLevelTabHost` renders the surface for it.
 */
export const Route = createFileRoute("/identities/$identityId")({
  beforeLoad: ({ context }) => {
    requireSignedIn(context);
  },
  component: IdentityRoute,
});
