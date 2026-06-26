import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import { useAuthService } from "@/lib/host";
import { useAuthServiceError } from "@/hooks/auth/use-auth-service-error";
import { useAuthDeviceProgress } from "@/hooks/auth/use-auth-device-progress";
import {
  AUTH_ERROR_DEVICE_DENIED,
  AUTH_ERROR_DEVICE_EXPIRED,
  AUTH_ERROR_LAUNCH_FAILED,
  AUTH_ERROR_SESSION_EXPIRED,
  AUTH_ERROR_SIGN_IN_FAILED,
  AUTH_ERROR_TIMEOUT,
  type AuthService,
  type DeviceFlowProgress,
} from "@/lib/auth/auth-service";
import { useAuthStore, type AuthStatus } from "@/stores/auth/auth-store";
import { cn } from "@/lib/utils";

export interface SignInButtonProps {
  readonly layout: "compact" | "hero";
}

/**
 * Header sign-in surface. Routes through the GUI-owned `AuthService` so the
 * sign-in flow uses the runner-host browser bridge - never a direct
 * `runnerHost.openExternalLink` call from UI code.
 *
 * The signed-out surface presents the primary "Sign in" affordance, which
 * funnels into `AuthService` so AuthnV3 validation runs once.
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

  if (status === "signed-in") {
    return null;
  }

  const isSigningIn = status === "signing-in";
  const isHero = props.layout === "hero";

  return (
    <div
      className={cn(
        isHero ? "flex w-full flex-col gap-4" : "flex items-center gap-2",
      )}
      data-testid="signin-controls"
      data-layout={props.layout}
    >
      <SignInErrorMessage
        status={status}
        lastError={lastError}
        isHero={isHero}
      />
      <DeviceCodeProgress progress={deviceProgress} isHero={isHero} />
      <PrimarySignInButton
        auth={auth}
        isHero={isHero}
        isSigningIn={isSigningIn}
      />
      <RetrySignInButton
        auth={auth}
        isHero={isHero}
        isSigningIn={isSigningIn}
      />
      <DeviceCodeFallback
        auth={auth}
        status={status}
        lastError={lastError}
        isSigningIn={isSigningIn}
        hasDeviceProgress={deviceProgress !== null}
        isHero={isHero}
      />
    </div>
  );
}

/**
 * Device-flow fallback affordance. Unobtrusive while a redirect attempt is
 * mid-flight ("Having trouble?"), and promoted to a prominent CTA when the
 * redirect could not launch / timed out - the two cases where the seamless
 * browser path is known to be unavailable. Hidden once a device attempt is
 * itself in flight (its progress panel takes over), and on an idle signed-out
 * surface where the primary "Sign in" button is the CTA.
 */
function DeviceCodeFallback(props: {
  readonly auth: AuthService;
  readonly status: AuthStatus;
  readonly lastError: string | null;
  readonly isSigningIn: boolean;
  readonly hasDeviceProgress: boolean;
  readonly isHero: boolean;
}) {
  if (props.hasDeviceProgress) {
    return null;
  }
  const isLaunchBlocked =
    props.status === "signed-out" &&
    (props.lastError === AUTH_ERROR_LAUNCH_FAILED ||
      props.lastError === AUTH_ERROR_TIMEOUT);
  if (!props.isSigningIn && !isLaunchBlocked) {
    return null;
  }
  return (
    <Button
      type="button"
      size={props.isHero ? "default" : "sm"}
      variant={isLaunchBlocked ? "outline" : "link"}
      data-testid="signin-device-code-link"
      onClick={() => {
        void props.auth.signInWithDeviceCode();
      }}
      className={cn(
        "cursor-pointer",
        props.isHero && !isLaunchBlocked
          ? "h-auto justify-center px-0 py-0 text-ui-sm"
          : null,
      )}
    >
      {isLaunchBlocked
        ? "Use a sign-in code instead"
        : "Having trouble? Use a code instead"}
    </Button>
  );
}

/**
 * Active device-flow progress: the human-handled code + where to enter it, so
 * the device fallback is never a silent spinner. Rendered only while a device
 * attempt is in flight.
 */
function DeviceCodeProgress(props: {
  readonly progress: DeviceFlowProgress | null;
  readonly isHero: boolean;
}) {
  const progress = props.progress;
  if (progress === null) {
    return null;
  }
  return (
    <div
      className={cn(
        "flex flex-col gap-1 rounded-md border border-border bg-muted/40 p-3",
        props.isHero ? "w-full text-ui-sm" : "text-ui-xs",
      )}
      data-testid="signin-device-progress"
    >
      <span className="text-muted-foreground">
        Enter this code at {progress.verificationUri}
      </span>
      <span
        className="font-mono text-base font-semibold tracking-widest"
        data-testid="signin-device-code"
      >
        {progress.userCode}
      </span>
      <span className="flex items-center gap-1.5 text-muted-foreground">
        Waiting for approval in your browser
        <AgentSpinningDots
          variant="dots"
          className="ml-0.5"
          testId="signin-device-spinner"
        />
      </span>
    </div>
  );
}

function SignInErrorMessage(props: {
  readonly status: AuthStatus;
  readonly lastError: string | null;
  readonly isHero: boolean;
}) {
  if (
    props.status !== "signed-out" ||
    props.lastError === null ||
    props.lastError === AUTH_ERROR_SESSION_EXPIRED
  ) {
    return null;
  }

  return (
    <span
      className={cn(
        "text-destructive",
        props.isHero ? "text-ui-sm leading-6" : "text-ui-xs",
      )}
      data-testid="signin-error"
      role="alert"
    >
      {messageForError(props.lastError)}
      <span className="sr-only" data-testid="signin-error-detail">
        {props.lastError}
      </span>
    </span>
  );
}

function PrimarySignInButton(props: {
  readonly auth: AuthService;
  readonly isHero: boolean;
  readonly isSigningIn: boolean;
}) {
  const label = props.isSigningIn ? "Signing in" : "Sign in";

  return (
    <Button
      type="button"
      size={props.isHero ? "lg" : "sm"}
      variant={props.isHero ? "default" : "outline"}
      disabled={props.isSigningIn}
      onClick={() => {
        void props.auth.signIn();
      }}
      data-testid="signin-button"
      className={cn("cursor-pointer", props.isHero ? "w-full" : null)}
    >
      {label}
      {props.isSigningIn ? (
        <AgentSpinningDots
          variant="dots"
          className="ml-1.5"
          testId="signin-spinner"
        />
      ) : null}
    </Button>
  );
}

function RetrySignInButton(props: {
  readonly auth: AuthService;
  readonly isHero: boolean;
  readonly isSigningIn: boolean;
}) {
  if (!props.isSigningIn) return null;

  return (
    // A stalled browser attempt (callback never returns) would otherwise leave
    // the user stuck on "Signing in" until the timeout. `signIn()` is
    // re-entrant - it supersedes the in-flight attempt and re-opens the sign-in
    // surface - so this gives an immediate escape hatch.
    <Button
      type="button"
      size={props.isHero ? "default" : "sm"}
      variant="link"
      data-testid="signin-retry-link"
      onClick={() => {
        void props.auth.signIn();
      }}
      className={cn(
        props.isHero ? "h-auto justify-center px-0 py-0 text-ui-sm" : null,
      )}
    >
      Taking too long? Retry
    </Button>
  );
}

function messageForError(error: string): string {
  if (error === AUTH_ERROR_TIMEOUT) {
    return "Sign in timed out. Please try again.";
  }
  if (error === AUTH_ERROR_LAUNCH_FAILED) {
    return "Could not open browser. Please try again.";
  }
  if (error === AUTH_ERROR_SESSION_EXPIRED) {
    return "Session expired - sign in again.";
  }
  if (error === AUTH_ERROR_SIGN_IN_FAILED) {
    return "Sign-in failed - please try again.";
  }
  if (error === AUTH_ERROR_DEVICE_DENIED) {
    return "Request denied - sign in again.";
  }
  if (error === AUTH_ERROR_DEVICE_EXPIRED) {
    return "The code expired - start again.";
  }
  return "Sign in failed. Please try again.";
}
