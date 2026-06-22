import { AuthLandingPage } from "@/components/auth/auth-landing-page";
import { HomePage } from "@/components/home/home-page";
import { useAuthStore } from "@/stores/auth/auth-store";

/**
 * Root index route body.
 *
 * Signed-out users land on the auth-first desktop welcome surface. Once
 * authentication succeeds, `/` becomes the normal landing workspace; the
 * surrounding `LocalHostGate` still blocks the composer until the desktop's
 * local host is ready.
 */
export function RootLandingPage() {
  const status = useAuthStore((state) => state.status);

  if (status !== "signed-in") {
    return <AuthLandingPage />;
  }

  return <HomePage />;
}
