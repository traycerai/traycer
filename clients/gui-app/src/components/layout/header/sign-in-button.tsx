import { useAuthDeviceProgress } from "@/hooks/auth/use-auth-device-progress";
import { AUTH_ERROR_ACCOUNT_UNAVAILABLE } from "@/lib/auth/auth-service";
import { useAuthServiceError } from "@/hooks/auth/use-auth-service-error";
import { useAuthService } from "@/lib/host";
import { cn } from "@/lib/utils";
import { isMobileApp } from "@/lib/mobile-app";
import { useAuthStore } from "@/stores/auth/auth-store";
import { DeviceCodeProgress } from "./sign-in/device-code-progress";
import { LinkCodeSignIn } from "./sign-in/link-code-sign-in";
import {
  PrimarySignInButton,
  RetrySignInButton,
} from "./sign-in/sign-in-action-buttons";
import { SignInErrorMessage } from "./sign-in/sign-in-error-message";
import { type SignInLayout } from "./sign-in/types";
import type { DeviceFlowProgress } from "@/lib/auth/auth-service";

export interface SignInButtonProps {
  readonly layout: SignInLayout;
}

/**
 * The action set below the error/progress area. The mobile app's hero
 * sign-in leads with the scan-to-link path: a full-width primary "Scan QR
 * code" with the browser device flow as a same-width secondary beneath it,
 * and manual code entry as a tertiary link inside the CTA block.
 * Product-gated, not capability-gated: typing the code is the same flow
 * where the camera is absent (simulator) or denied. Everywhere else the
 * device flow stays primary, with the link-code entry as a quiet extra line
 * on the mobile app's compact header only.
 */
function SignInActions(props: {
  readonly isHero: boolean;
  readonly isSigningIn: boolean;
  /**
   * Whether the running attempt is one `signIn()` may replace. A link claim is
   * not: `signIn()` is re-entrant and its `beginAttempt()` discards whatever
   * is in flight, so offering Retry mid-claim offers to throw away a request
   * the user's desktop is prompting them to approve.
   */
  readonly canRetry: boolean;
  /**
   * Forwarded to whichever `PrimarySignInButton` this form factor renders: the
   * "account is gone server-side" label belongs to the button on every one of
   * them, so it travels with the action set rather than with the desktop
   * branch that first needed it.
   */
  readonly offersDifferentAccount: boolean;
  readonly deviceProgress: DeviceFlowProgress | null;
}) {
  // Computed here rather than inline: `RetrySignInButton` reads this as "show
  // yourself", and a link claim is an attempt `signIn()` must not replace.
  const showRetry = props.isSigningIn && props.canRetry;
  if (props.deviceProgress !== null) {
    return (
      <DeviceCodeProgress
        progress={props.deviceProgress}
        isHero={props.isHero}
      />
    );
  }
  if (isMobileApp() && props.isHero) {
    return (
      <>
        <LinkCodeSignIn isHero={props.isHero} presentation="cta" />
        <PrimarySignInButton
          isHero={props.isHero}
          isSigningIn={props.isSigningIn}
          offersDifferentAccount={props.offersDifferentAccount}
          emphasis="secondary"
        />
        <RetrySignInButton isHero={props.isHero} isSigningIn={showRetry} />
      </>
    );
  }
  return (
    <>
      <PrimarySignInButton
        isHero={props.isHero}
        isSigningIn={props.isSigningIn}
        offersDifferentAccount={props.offersDifferentAccount}
        emphasis="primary"
      />
      <RetrySignInButton isHero={props.isHero} isSigningIn={showRetry} />
      {isMobileApp() ? (
        <LinkCodeSignIn isHero={props.isHero} presentation="link" />
      ) : null}
    </>
  );
}

/**
 * Header sign-in surface. Routes through the GUI-owned `AuthService` so the
 * sign-in flow uses the runner-host browser bridge - never a direct
 * `runnerHost.openExternalLink` call from UI code.
 *
 * The signed-out surface presents the sign-in affordances, which funnel into
 * `AuthService.signIn()` (the OAuth 2.0 Device Authorization Grant) or, on
 * the mobile app, `AuthService.signInWithLinkCode()` (the confirm-gated QR
 * link). The browser opens to the device-approval page and the in-flight
 * code + "waiting for approval" progress render inline (never a silent
 * spinner).
 *
 * Interactive sign-in failures render a visible failure message next to the
 * button so the user has a stable retry CTA. Stored-session expiry is handled
 * by the auth toast bridge, because it is global auth lifecycle state rather
 * than button-local presentation.
 */
export function SignInButton(props: SignInButtonProps) {
  const auth = useAuthService();
  const status = useAuthStore((state) => state.status);
  const signingInAttempt = useAuthStore((state) => state.signingInAttempt);
  const lastError = useAuthServiceError(auth);
  const deviceProgress = useAuthDeviceProgress(auth);
  const isHero = props.layout === "hero";
  const isSigningIn = status === "signing-in";
  // Only the device flow's own stalled round trip gets the retry escape hatch.
  const canRetry = signingInAttempt !== "link";

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
      <SignInActions
        isHero={isHero}
        isSigningIn={isSigningIn}
        canRetry={canRetry}
        offersDifferentAccount={lastError === AUTH_ERROR_ACCOUNT_UNAVAILABLE}
        deviceProgress={deviceProgress}
      />
    </div>
  );
}
