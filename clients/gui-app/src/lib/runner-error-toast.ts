import { readErrorMessage } from "@/lib/read-error-message";
import { createReportIssueContext } from "@/lib/report-issue-context";
import { reportableErrorToast } from "@/lib/reportable-error-toast";

export function toastFromRunnerError(error: unknown, fallback: string): void {
  const message = readErrorMessage(error);
  reportableErrorToast(
    fallback,
    message === null ? undefined : { description: message },
    createReportIssueContext({
      title: "Desktop operation failed",
      message: null,
      code: null,
      source: "Desktop",
    }),
  );
}
