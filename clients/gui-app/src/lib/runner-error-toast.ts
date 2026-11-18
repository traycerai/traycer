import { createElement, Fragment } from "react";
import type { ExternalToast } from "sonner";
import { readErrorMessage } from "@/lib/read-error-message";
import { createReportIssueContext } from "@/lib/report-issue-context";
import { reportableErrorToast } from "@/lib/reportable-error-toast";

export function toastFromRunnerError(error: unknown, fallback: string): void {
  showRunnerErrorToast(error, fallback, undefined);
}

export function toastFromRunnerErrorWithOptions(
  error: unknown,
  fallback: string,
  options: ExternalToast,
): void {
  showRunnerErrorToast(error, fallback, options);
}

function showRunnerErrorToast(
  error: unknown,
  fallback: string,
  options: ExternalToast | undefined,
): void {
  const message = readErrorMessage(error);
  let description: ExternalToast["description"] = options?.description;
  if (message !== null) {
    if (options?.description === undefined) {
      description = message;
    } else if (typeof options.description === "string") {
      description = `${options.description} ${message}`;
    } else if (typeof options.description === "function") {
      const originalDescription = options.description;
      description = () =>
        createElement(Fragment, null, originalDescription(), " ", message);
    } else {
      description = createElement(
        Fragment,
        null,
        options.description,
        " ",
        message,
      );
    }
  }
  reportableErrorToast(
    fallback,
    options === undefined && description === undefined
      ? undefined
      : { ...options, description },
    createReportIssueContext({
      title: "Desktop operation failed",
      message: null,
      code: null,
      source: "Desktop",
    }),
  );
}
