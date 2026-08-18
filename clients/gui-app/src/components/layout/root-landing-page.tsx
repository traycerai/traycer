import { AuthLandingPage } from "@/components/auth/auth-landing-page";
import { useAuthStore } from "@/stores/auth/auth-store";

/**
 * Root index route body.
 *
 * Signed-out users land on the auth-first desktop welcome surface. Once
 * authentication succeeds, `/` becomes the normal landing workspace; the
 * surrounding `DefaultHostReadyGate` still holds the composer back until a
 * host can serve the window, and the window narrator says why.
 */
export function RootLandingPage() {
  const status = useAuthStore((state) => state.status);

  if (status !== "signed-in") {
    return <AuthLandingPage />;
  }

  return null;
}
