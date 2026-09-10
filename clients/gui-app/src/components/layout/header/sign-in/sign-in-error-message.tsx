import {
  AUTH_ERROR_ACCOUNT_UNAVAILABLE,
  AUTH_ERROR_DEVICE_DENIED,
  AUTH_ERROR_DEVICE_EXPIRED,
  AUTH_ERROR_LAUNCH_FAILED,
  AUTH_ERROR_SESSION_EXPIRED,
  AUTH_ERROR_SIGNED_OUT_EVERYWHERE,
  AUTH_ERROR_SIGN_IN_FAILED,
  AUTH_ERROR_STORE_UNAVAILABLE,
} from "@/lib/auth/auth-service";
import { cn } from "@/lib/utils";
import { ReportIssueAction } from "@/components/report-issue/report-issue-action";
import { createReportIssueContext } from "@/lib/report-issue-context";
import { type AuthStatus } from "@/stores/auth/auth-store";

export function SignInErrorMessage(props: {
  readonly status: AuthStatus;
  readonly lastError: string | null;
  readonly isHero: boolean;
}) {
  // `AUTH_ERROR_ACCOUNT_UNAVAILABLE` renders under `unverified` as well as
  // `signed-out`, and it is the only error that does.
  //
  // The account arm HOLDS the local plane by product ruling, so it never
  // reaches `signed-out` - and this component and the session-expired toast
  // were the only two surfaces that could carry its copy, both keyed on states
  // that arm no longer visits. Without this widening a person whose account was
  // deleted gets the workspace and total silence, then watches cloud actions
  // fail one at a time with no explanation.
  //
  // Deliberately NOT widened to every error under `unverified`: the others are
  // sign-in-attempt failures that belong to a signed-out surface, and the
  // expiry case is the toast's (it is transient and self-clearing, this one is
  // terminal and must persist).
  const isTerminalAccountError =
    props.lastError === AUTH_ERROR_ACCOUNT_UNAVAILABLE;
  const statusCarriesError =
    props.status === "signed-out" ||
    (isTerminalAccountError && props.status === "unverified");
  if (
    !statusCarriesError ||
    props.lastError === null ||
    props.lastError === AUTH_ERROR_SESSION_EXPIRED ||
    props.lastError === AUTH_ERROR_SIGNED_OUT_EVERYWHERE
  ) {
    return null;
  }

  const message = messageForError(props.lastError);
  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-x-1 text-destructive",
        props.isHero ? "text-ui-sm leading-6" : "text-ui-xs",
      )}
      data-testid="signin-error"
      role="alert"
    >
      <span>{message}</span>
      <span
        className="sr-only"
        data-testid="signin-error-detail"
        aria-hidden="true"
      >
        {props.lastError}
      </span>
      <ReportIssueAction
        context={createReportIssueContext({
          title: "Sign in failed",
          message: null,
          code: null,
          source: "Sign in",
        })}
        presentation="link"
        className="h-auto p-0 text-current"
      />
    </div>
  );
}

function messageForError(error: string): string {
  if (error === AUTH_ERROR_LAUNCH_FAILED) {
    return "Could not start sign-in. Please try again.";
  }
  if (error === AUTH_ERROR_SESSION_EXPIRED) {
    return "Session expired - sign in again.";
  }
  if (error === AUTH_ERROR_SIGNED_OUT_EVERYWHERE) {
    return "You signed out everywhere - sign in again to continue.";
  }
  if (error === AUTH_ERROR_ACCOUNT_UNAVAILABLE) {
    // Deliberately does NOT say "sign in again": this arm is reached when authn
    // answered 403/404 for the account, and a retry with the same account
    // cannot succeed. See `AUTH_ERROR_ACCOUNT_UNAVAILABLE`.
    return "This account is no longer available.";
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
  if (error === AUTH_ERROR_STORE_UNAVAILABLE) {
    return "Could not read saved credentials. Please try again.";
  }
  return "Sign in failed. Please try again.";
}
