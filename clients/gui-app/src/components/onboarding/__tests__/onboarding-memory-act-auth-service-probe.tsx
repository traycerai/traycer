import type { AuthService } from "@/lib/auth/auth-service";
import { useAuthService } from "@/lib/host";

export function OnboardingMemoryActAuthServiceProbe(props: {
  readonly onAuthService: (service: AuthService) => void;
}): null {
  props.onAuthService(useAuthService());
  return null;
}
