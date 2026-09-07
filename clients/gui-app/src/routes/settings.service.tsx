import { createFileRoute, redirect } from "@tanstack/react-router";

/** Legacy /settings/service redirects to Settings Host so bookmarks still land on the sidebar's primary surface. */
export const Route = createFileRoute("/settings/service")({
  beforeLoad: () => {
    // throw: true so redirect() throws the Response. Avoids an explicit throw
    // keyword for only-throw-error.
    redirect({ throw: true, to: "/settings/host", replace: true });
  },
});
