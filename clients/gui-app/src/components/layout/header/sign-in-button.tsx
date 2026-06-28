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

  if (status === "signed-in") {
    return null;
  }

  const isSigningIn = status === "signing-in";
  const isHero = props.layout === "hero";

  return (
    <div
      className={cn(
        "flex",
        isHero && "w-full flex-col gap-4",
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
      <DeviceCodeProgress
        auth={auth}
        progress={deviceProgress}
        isHero={isHero}
      />
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
    </div>
  );
}

/**
 * Active device-flow progress. The app already auto-opens the pre-filled
 * approval page; this surface leads with a one-click "open approval page"
 * affordance (re-opening `verification_uri_complete`, code embedded) so the
 * user only ever has to click Approve - never type the code. The code + bare
 * URL remain as a manual fallback, and the spinner keeps it from being a silent
 * wait. Rendered while a device attempt is in flight.
 */
function DeviceCodeProgress(props: {
  readonly auth: AuthService;
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
        "flex flex-col gap-3 rounded-lg border border-border bg-card p-4 text-card-foreground shadow-sm",
        props.isHero ? "w-full text-ui-sm" : "w-full min-w-0 text-ui-xs",
      )}
      data-testid="signin-device-progress"
    >
      <span className="font-medium text-foreground">
        Approve this sign-in in your browser.
      </span>
      <Button
        size={props.isHero ? "default" : "sm"}
        className="w-full"
        onClick={() => props.auth.openVerificationPage()}
        data-testid="signin-open-approval"
      >
        Open the approval page
      </Button>
      <span className="flex items-center gap-1.5 text-muted-foreground">
        Waiting for approval
        <AgentSpinningDots
          variant="dots"
          className="ml-0.5"
          testId="signin-device-spinner"
        />
      </span>
      <span className="flex flex-wrap items-center gap-x-1.5 gap-y-1 border-t border-border pt-3 text-muted-foreground">
        Or enter
        <code
          className="rounded-sm border border-border bg-muted px-1.5 py-0.5 font-mono font-semibold tracking-widest text-foreground"
          data-testid="signin-device-code"
        >
          {progress.userCode}
        </code>
        at
        <span className="min-w-0 break-all font-medium text-foreground">
          {progress.verificationUri}
        </span>
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
  if (error === AUTH_ERROR_LAUNCH_FAILED) {
    return "Could not start sign-in. Please try again.";
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
