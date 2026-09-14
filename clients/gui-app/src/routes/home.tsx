import { createFileRoute, redirect } from "@tanstack/react-router";
import { requireSignedIn } from "@/lib/router-auth";
import { isHomeTabEnabled } from "@/stores/settings/settings-store";
import { HomeRoute } from "./home-route-components";

export const Route = createFileRoute("/home")({
  beforeLoad: ({ context }) => {
    requireSignedIn(context);
    // With the Home tab off there is no Home surface, so `/home` is not a place
    // this build can land on. A stale link or a restored location goes back to
    // `/`, which resolves to whatever this window is actually showing.
    if (!isHomeTabEnabled()) {
      redirect({ to: "/", replace: true, throw: true });
    }
  },
  component: HomeRoute,
});
