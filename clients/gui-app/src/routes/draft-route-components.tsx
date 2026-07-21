import { RootLandingPage } from "@/components/layout/root-landing-page";
import { useAuthStore } from "@/stores/auth/auth-store";

export function DraftRoute() {
  const status = useAuthStore((state) => state.status);
  return status === "signed-in" ? null : <RootLandingPage />;
}
