import {
  AUTH_ERROR_DEVICE_DENIED,
  AUTH_ERROR_DEVICE_EXPIRED,
  AUTH_ERROR_LAUNCH_FAILED,
  AUTH_ERROR_SESSION_EXPIRED,
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
  if (
    props.status !== "signed-out" ||
    props.lastError === null ||
    props.lastError === AUTH_ERROR_SESSION_EXPIRED
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
