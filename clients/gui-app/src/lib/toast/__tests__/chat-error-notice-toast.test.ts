import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatErrorNotice } from "@traycer/protocol/host/agent/gui/subscribe";

import { TOO_MANY_ATTACHMENTS_CODE } from "@traycer/protocol/common/file-attachment";
import { showErrorNoticeToast } from "@/lib/toast/chat-error-notice-toast";

const mocks = vi.hoisted(() => ({
  warning: vi.fn(),
  reportableError: vi.fn(),
  reportableWarning: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), { warning: mocks.warning }),
}));

vi.mock("@/lib/reportable-error-toast", () => ({
  reportableErrorToast: mocks.reportableError,
  reportableWarningToast: mocks.reportableWarning,
  createRetainingReportAction: vi.fn(),
}));

function notice(overrides: Partial<ChatErrorNotice>): ChatErrorNotice {
  return {
    code: TOO_MANY_ATTACHMENTS_CODE,
    message: "This message has 21 files; a message can carry up to 20.",
    severity: "error",
    clientActionId: null,
    ...overrides,
  };
}

beforeEach(() => {
  mocks.warning.mockClear();
  mocks.reportableError.mockClear();
  mocks.reportableWarning.mockClear();
});

describe("showErrorNoticeToast for TOO_MANY_ATTACHMENTS", () => {
  it.each(["error", "warning"] as const)(
    "a %s notice is a plain warning carrying the host's text, with no report offer",
    (severity) => {
      showErrorNoticeToast(notice({ severity }), false);

      expect(mocks.warning).toHaveBeenCalledWith("Too many files attached", {
        description: "This message has 21 files; a message can carry up to 20.",
      });
      expect(mocks.reportableError).not.toHaveBeenCalled();
      expect(mocks.reportableWarning).not.toHaveBeenCalled();
    },
  );

  it("any other error notice still offers to report", () => {
    showErrorNoticeToast(notice({ code: "SOMETHING_ELSE" }), false);

    expect(mocks.reportableError).toHaveBeenCalledTimes(1);
    expect(mocks.warning).not.toHaveBeenCalled();
  });
});
