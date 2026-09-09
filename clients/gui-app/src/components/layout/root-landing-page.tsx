import { AuthLandingPage } from "@/components/auth/auth-landing-page";
import { admitsLocalPlane, useAuthStore } from "@/stores/auth/auth-store";

/**
 * Root index route body.
 *
 * Signed-out users land on the auth-first desktop welcome surface. Once
 * authentication succeeds, `/` becomes the normal landing workspace; the
 * surrounding `DefaultHostReadyGate` still holds the composer back until a
 * host can serve the window, and the window narrator says why.
 *
 * The test is `admitsLocalPlane`, NOT `status === "signed-in"`, and the
 * difference is the whole point: a stored session that authn was unreachable
 * to confirm (`unverified`) still gets the workspace, because the epics it
 * would show are served from this machine's disk and need no network at all.
 * Sending that user here instead used to park them on a sign-in page in front
 * of their own data. Everything cloud-backed inside the workspace keeps
 * gating on `signed-in` and stays gated.
 */
export function RootLandingPage() {
  const status = useAuthStore((state) => state.status);

  if (!admitsLocalPlane(status)) {
    return <AuthLandingPage />;
  }

  return null;
}
