import { AuthLandingPage } from "@/components/auth/auth-landing-page";
import { useAuthStore } from "@/stores/auth/auth-store";

/** Once authentication succeeds, `/` becomes the normal landing workspace. */
export function RootLandingPage() {
  const status = useAuthStore((state) => state.status);

  if (status !== "signed-in") {
    return <AuthLandingPage />;
  }

  return null;
}
