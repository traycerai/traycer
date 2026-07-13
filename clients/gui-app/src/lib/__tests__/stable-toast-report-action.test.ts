import { afterEach, describe, expect, it } from "vitest";
import { toast, type ToastT } from "sonner";
import { reportableErrorToast } from "@/lib/reportable-error-toast";
import { scopedToastChannel } from "@/lib/toast/toast-channel";
import { useDesktopDialogStore } from "@/stores/dialogs/desktop-dialog-store";

const LOADING_TOAST_ID = "report-action-error-to-loading";
const SUCCESS_TOAST_PREFIX = "report-action-error-to-success";
const REPORT_CONTEXT = {
  title: "Traycer operation failed",
  message: null,
  code: null,
  source: "Traycer app",
};

afterEach(() => {
  toast.dismiss(LOADING_TOAST_ID);
  toast.dismiss(`${SUCCESS_TOAST_PREFIX}:scope`);
  useDesktopDialogStore.getState().close();
  useDesktopDialogStore.setState({ reportIssueAvailable: false });
});

describe("stable-id toast report actions", () => {
  it("clears the report action when an error is replaced by loading", () => {
    useDesktopDialogStore.setState({ reportIssueAvailable: true });
    reportableErrorToast(
      "Operation failed",
      { id: LOADING_TOAST_ID },
      REPORT_CONTEXT,
    );
    expect(readToast(LOADING_TOAST_ID).cancel).not.toBeNull();

    toast.loading("Trying again", {
      id: LOADING_TOAST_ID,
      cancel: null,
    });

    expect(readToast(LOADING_TOAST_ID)).toMatchObject({
      type: "loading",
      cancel: null,
    });
  });

  it("clears the report action when a shared channel error becomes success", () => {
    useDesktopDialogStore.setState({ reportIssueAvailable: true });
    const channel = scopedToastChannel(SUCCESS_TOAST_PREFIX)("scope");
    channel.error("Operation failed");
    expect(readToast(channel.id).cancel).not.toBeNull();

    channel.success("Operation completed");

    expect(readToast(channel.id)).toMatchObject({
      type: "success",
      cancel: null,
    });
  });

  it("clears a same-ID report action when support capability is lost", () => {
    useDesktopDialogStore.setState({ reportIssueAvailable: true });
    reportableErrorToast(
      "Operation failed",
      { id: LOADING_TOAST_ID },
      REPORT_CONTEXT,
    );
    expect(readToast(LOADING_TOAST_ID).cancel).not.toBeNull();

    useDesktopDialogStore.setState({ reportIssueAvailable: false });
    reportableErrorToast(
      "Operation still failed",
      { id: LOADING_TOAST_ID },
      REPORT_CONTEXT,
    );

    expect(readToast(LOADING_TOAST_ID)).toMatchObject({
      type: "error",
      cancel: null,
    });
  });
});

function readToast(id: string): ToastT {
  const entry = toast
    .getToasts()
    .find((candidate) => candidate.id === id && "title" in candidate);
  if (entry === undefined || !("title" in entry)) {
    throw new Error(`Expected active toast ${id}`);
  }
  return entry;
}
