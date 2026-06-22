import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import { useAuthService } from "@/lib/host";
import { useAuthServiceError } from "@/hooks/auth/use-auth-service-error";
import {
  AUTH_ERROR_LAUNCH_FAILED,
  AUTH_ERROR_SESSION_EXPIRED,
  AUTH_ERROR_SIGN_IN_FAILED,
  AUTH_ERROR_TIMEOUT,
  type AuthService,
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
  return "Sign in failed. Please try again.";
}
