import { useAuthDeviceProgress } from "@/hooks/auth/use-auth-device-progress";
import { useAuthServiceError } from "@/hooks/auth/use-auth-service-error";
import { useAuthService } from "@/lib/host";
import { cn } from "@/lib/utils";
import { useAuthStore } from "@/stores/auth/auth-store";
import { DeviceCodeProgress } from "./sign-in/device-code-progress";
import {
  PrimarySignInButton,
  RetrySignInButton,
} from "./sign-in/sign-in-action-buttons";
import { SignInErrorMessage } from "./sign-in/sign-in-error-message";
import { type SignInLayout } from "./sign-in/types";

export interface SignInButtonProps {
  readonly layout: SignInLayout;
}

/**
 * Header sign-in surface. Routes through the GUI-owned `AuthService` so the
 * sign-in flow uses the runner-host browser bridge - never a direct
 * `runnerHost.openExternalLink` call from UI code.
 *
 * The signed-out surface presents the single "Sign in" affordance, which
 * funnels into `AuthService.signIn()` - the OAuth 2.0 Device Authorization
 * Grant. The browser opens to the device-approval page and the in-flight code +
 * "waiting for approval" progress render inline (never a silent spinner).
 *
 * Interactive sign-in failures render a visible failure message next to the
 * button so the user has a stable retry CTA. Stored-session expiry is handled
 * by the auth toast bridge, because it is global auth lifecycle state rather
 * than button-local presentation.
 */
export function SignInButton(props: SignInButtonProps) {
  const auth = useAuthService();
  const status = useAuthStore((state) => state.status);
  const lastError = useAuthServiceError(auth);
  const deviceProgress = useAuthDeviceProgress(auth);
  const isHero = props.layout === "hero";
  const isSigningIn = status === "signing-in";

  if (status === "signed-in") {
    return null;
  }

  return (
    <div
      className={cn(
        "flex",
        isHero && "w-full flex-col gap-3",
        !isHero && "gap-2",
        // Compact mode sits in the header's non-wrapping controls row. While the
        // device panel is showing, stack full-width so the verification URL and
        // buttons wrap cleanly instead of being pushed off-screen.
        !isHero && deviceProgress !== null && "w-full flex-col",
        !isHero && deviceProgress === null && "items-center",
      )}
      data-testid="signin-controls"
      data-layout={props.layout}
    >
      <SignInErrorMessage
        status={status}
        lastError={lastError}
        isHero={isHero}
      />
      {deviceProgress !== null ? (
        <DeviceCodeProgress progress={deviceProgress} isHero={isHero} />
      ) : (
        <>
          <PrimarySignInButton isHero={isHero} isSigningIn={isSigningIn} />
          <RetrySignInButton isHero={isHero} isSigningIn={isSigningIn} />
        </>
      )}
    </div>
  );
}
