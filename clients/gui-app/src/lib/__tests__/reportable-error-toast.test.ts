import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import type { ExternalToast } from "sonner";
import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";

const errorToast = vi.hoisted(() =>
  vi.fn<(message: ReactNode, options: ExternalToast | undefined) => string>(
    () => "toast-id",
  ),
);
const warningToast = vi.hoisted(() =>
  vi.fn<(message: ReactNode, options: ExternalToast | undefined) => string>(
    () => "toast-id",
  ),
);

vi.mock("sonner", () => ({
  toast: { error: errorToast, warning: warningToast },
}));

import { toastFromAuthError } from "@/lib/auth-error-toast";
import { toastFromHostErrorWithDetail } from "@/lib/host-error-toast";
import {
  reportableErrorToast,
  reportableWarningToast,
} from "@/lib/reportable-error-toast";
import { toastFromRunnerError } from "@/lib/runner-error-toast";
import { useDesktopDialogStore } from "@/stores/dialogs/desktop-dialog-store";

const SAFE_CONTEXT = {
  title: "Could not load Epic",
  message: "The Epic could not be loaded.",
  code: null,
  source: "Epic list",
};

afterEach(() => {
  errorToast.mockClear();
  warningToast.mockClear();
  useDesktopDialogStore.setState({
    activeDialog: null,
    reportIssueAvailable: false,
    reportIssueContext: null,
    reportIssueDraftId: 0,
  });
});

describe("reportableErrorToast", () => {
  it("preserves an ordinary error toast when desktop reporting is unavailable", () => {
    reportableErrorToast("Couldn't load", undefined, SAFE_CONTEXT);

    expect(errorToast).toHaveBeenCalledWith("Couldn't load");
  });

  it("uses only the explicitly supplied privacy-safe context", () => {
    useDesktopDialogStore.setState({ reportIssueAvailable: true });
    const unsafeVisibleCopy =
      "alice@example.com could not open /Users/alice/secret-project/private.png";

    reportableErrorToast(
      unsafeVisibleCopy,
      {
        description: "hidden raw error: --value sk-secret-123",
      },
      SAFE_CONTEXT,
    );
    clickErrorReportAction();

    expect(errorToast).toHaveBeenCalledWith(
      unsafeVisibleCopy,
      expect.objectContaining({
        description: "hidden raw error: --value sk-secret-123",
      }),
    );
    expect(useDesktopDialogStore.getState().reportIssueContext).toEqual(
      SAFE_CONTEXT,
    );
    expect(
      JSON.stringify(useDesktopDialogStore.getState().reportIssueContext),
    ).not.toMatch(
      /alice@example\.com|private\.png|\/Users\/alice|sk-secret-123|hidden raw error/,
    );
  });

  it("replaces an already-open ordinary draft with the most recently selected context", () => {
    useDesktopDialogStore.setState({ reportIssueAvailable: true });
    useDesktopDialogStore.getState().openReportIssueWithContext({
      title: "Earlier error",
      message: null,
      code: null,
      source: "Earlier area",
    });
    const previousDraftId = useDesktopDialogStore.getState().reportIssueDraftId;

    reportableErrorToast("Couldn't load", undefined, SAFE_CONTEXT);
    clickErrorReportAction();

    expect(useDesktopDialogStore.getState()).toMatchObject({
      activeDialog: "report-issue",
      reportIssueContext: SAFE_CONTEXT,
      reportIssueDraftId: previousDraftId + 1,
    });
  });

  it("rechecks capability before a visible report action opens a draft", () => {
    useDesktopDialogStore.setState({ reportIssueAvailable: true });
    reportableErrorToast("Couldn't load", undefined, SAFE_CONTEXT);
    const action = readToastOptions().cancel;
    useDesktopDialogStore.setState({ reportIssueAvailable: false });

    clickReportAction(action);

    expect(useDesktopDialogStore.getState().activeDialog).toBeNull();
    expect(useDesktopDialogStore.getState().reportIssueContext).toBeNull();
  });

  it("preserves an explicitly composed cancel slot", () => {
    useDesktopDialogStore.setState({ reportIssueAvailable: true });

    reportableErrorToast("Couldn't update", { cancel: null }, SAFE_CONTEXT);

    expect(readToastOptions().cancel).toBeNull();
  });

  it("preserves a caller-supplied cancel action for a stable toast when reporting is unavailable", () => {
    const cancel = { label: "Dismiss", onClick: vi.fn() };

    reportableErrorToast(
      "Couldn't update",
      { id: "stable-error", cancel },
      SAFE_CONTEXT,
    );

    expect(errorToast).toHaveBeenCalledWith("Couldn't update", {
      id: "stable-error",
      cancel,
    });
  });

  it("keeps warning severity and a primary action while adding reporting", () => {
    useDesktopDialogStore.setState({ reportIssueAvailable: true });
    const retry = vi.fn();
    const action = { label: "Retry", onClick: retry };

    reportableWarningToast("Partially completed", { action }, SAFE_CONTEXT);

    expect(warningToast).toHaveBeenCalledWith(
      "Partially completed",
      expect.objectContaining({ action }),
    );
    clickReportAction(readWarningOptions().cancel);
    expect(useDesktopDialogStore.getState().reportIssueContext).toEqual(
      SAFE_CONTEXT,
    );
    expect(retry).not.toHaveBeenCalled();
  });

  it("explicitly clears warning report actions when capability is unavailable", () => {
    reportableWarningToast(
      "Partially completed",
      { id: "stable-warning" },
      SAFE_CONTEXT,
    );

    expect(warningToast).toHaveBeenCalledWith("Partially completed", {
      id: "stable-warning",
      cancel: null,
    });
  });

  it("rechecks capability before a warning report action opens a draft", () => {
    useDesktopDialogStore.setState({ reportIssueAvailable: true });
    reportableWarningToast("Partially completed", undefined, SAFE_CONTEXT);
    const action = readWarningOptions().cancel;
    useDesktopDialogStore.setState({ reportIssueAvailable: false });

    clickReportAction(action);

    expect(useDesktopDialogStore.getState().activeDialog).toBeNull();
    expect(useDesktopDialogStore.getState().reportIssueContext).toBeNull();
  });
});

describe("shared error helpers", () => {
  it("keeps runner details visible without putting env secrets in the draft", () => {
    useDesktopDialogStore.setState({ reportIssueAvailable: true });
    const rawError =
      "Command failed: traycer env set API_KEY --value sk-secret-123";

    toastFromRunnerError(new Error(rawError), "Failed to save env override");
    expect(readToastOptions().description).toBe(rawError);
    clickErrorReportAction();

    expect(useDesktopDialogStore.getState().reportIssueContext).toEqual({
      title: "Desktop operation failed",
      message: null,
      code: null,
      source: "Desktop",
    });
  });

  it("keeps user identifiers out of authentication report context", () => {
    useDesktopDialogStore.setState({ reportIssueAvailable: true });

    toastFromAuthError(
      new Error("Authentication failed for alice@example.com"),
      "Couldn't sign in",
    );
    clickErrorReportAction();

    expect(useDesktopDialogStore.getState().reportIssueContext).toEqual({
      title: "Authentication failed",
      message: null,
      code: null,
      source: "Authentication",
    });
  });

  it("keeps hidden host paths and filenames out while retaining a stable code", () => {
    useDesktopDialogStore.setState({ reportIssueAvailable: true });
    const error = new HostRpcError({
      code: "RPC_ERROR",
      message: "Could not read /Users/alice/project/private.txt",
      requestId: "request-1",
      method: "workspace.readFile",
      fatalDetails: null,
    });

    toastFromHostErrorWithDetail(error, "Couldn't read workspace file.");
    clickErrorReportAction();

    expect(useDesktopDialogStore.getState().reportIssueContext).toEqual({
      title: "Host operation failed",
      message: null,
      code: "RPC_ERROR",
      source: "Host",
    });
  });
});

function clickErrorReportAction(): void {
  clickReportAction(readToastOptions().cancel);
}

function clickReportAction(cancel: ExternalToast["cancel"]): void {
  if (typeof cancel !== "object" || cancel === null || !("onClick" in cancel)) {
    throw new Error("Expected a report issue action.");
  }
  const action = render(
    createElement(
      "button",
      { type: "button", onClick: cancel.onClick },
      "Trigger report issue",
    ),
  );
  fireEvent.click(action.getByRole("button", { name: "Trigger report issue" }));
  action.unmount();
}

function readToastOptions(): ExternalToast {
  const call = errorToast.mock.lastCall;
  if (call === undefined || call[1] === undefined) {
    throw new Error("Expected toast options.");
  }
  return call[1];
}

function readWarningOptions(): ExternalToast {
  const call = warningToast.mock.lastCall;
  if (call === undefined || call[1] === undefined) {
    throw new Error("Expected warning toast options.");
  }
  return call[1];
}
