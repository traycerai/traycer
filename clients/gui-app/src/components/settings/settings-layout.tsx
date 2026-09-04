import { RootLandingPage } from "@/components/layout/root-landing-page";
import { admitsLocalPlane, useAuthStore } from "@/stores/auth/auth-store";

export function SettingsLayout() {
  const status = useAuthStore((state) => state.status);
  return admitsLocalPlane(status) ? null : <RootLandingPage />;
}
