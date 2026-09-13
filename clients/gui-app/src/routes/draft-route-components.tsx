import { RootLandingPage } from "@/components/layout/root-landing-page";
import { admitsLocalPlane, useAuthStore } from "@/stores/auth/auth-store";

export function DraftRoute() {
  const status = useAuthStore((state) => state.status);
  return admitsLocalPlane(status) ? null : <RootLandingPage />;
}
