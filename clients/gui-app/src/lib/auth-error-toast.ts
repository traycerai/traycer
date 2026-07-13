import { readErrorMessage } from "@/lib/read-error-message";
import { createReportIssueContext } from "@/lib/report-issue-context";
import { reportableErrorToast } from "@/lib/reportable-error-toast";

export function toastFromAuthError(error: unknown, fallback: string): void {
  const message = readErrorMessage(error);
  reportableErrorToast(
    fallback,
    message === null ? undefined : { description: message },
    createReportIssueContext({
      title: "Authentication failed",
      message: null,
      code: null,
      source: "Authentication",
    }),
  );
}
