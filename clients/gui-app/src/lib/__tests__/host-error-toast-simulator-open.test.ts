import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import { toastFromHostError } from "@/lib/host-error-toast";
import { useDesktopDialogStore } from "@/stores/dialogs/desktop-dialog-store";

vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));

const FALLBACK = "Couldn't open the simulator.";
const OFF_GUIDANCE =
  "Mobile simulators are off. Turn them on in the Host panel to install the tools.";

function openError(message: string): HostRpcError {
  return new HostRpcError({
    code: "RPC_ERROR",
    message,
    requestId: "simulator-open-refused",
    method: "simulator.open",
    fatalDetails: null,
  });
}

beforeEach(() => {
  // Reporting must be available for these assertions to catch a refusal
  // accidentally going through the real reportableErrorToast path.
  useDesktopDialogStore.getState().setReportIssueAvailable(true);
});

afterEach(() => {
  vi.clearAllMocks();
  useDesktopDialogStore.setState(useDesktopDialogStore.getInitialState());
});

describe("simulator open refusals through toastFromHostError", () => {
  it.each([
    ["off", OFF_GUIDANCE],
    ["installing", "Simulator tools are being installed."],
    [
      "unsupported",
      "Simulator support is not available for this machine's processor.",
    ],
  ])(
    "shows the host's guidance for state=%s without Report issue",
    (state, guidance) => {
      toastFromHostError(
        openError(`simulator unavailable (state=${state}): ${guidance}`),
        FALLBACK,
      );

      expect(toast.error).toHaveBeenCalledExactlyOnceWith(guidance);
    },
  );

  it("keeps the fallback for empty guidance without Report issue", () => {
    toastFromHostError(
      openError("simulator unavailable (state=off): "),
      FALLBACK,
    );

    expect(toast.error).toHaveBeenCalledExactlyOnceWith(FALLBACK);
  });

  it.each([
    "simulator unavailable (state=failed): The installed simulator tools are incomplete (missing simulator-hub).",
    "simulator unavailable (state=hub): the hub exited (code=1 signal=null)",
  ])("keeps Report issue for a genuine open failure: %s", (message) => {
    toastFromHostError(openError(message), FALLBACK);

    expect(toast.error).toHaveBeenCalledTimes(1);
    const call = vi.mocked(toast.error).mock.calls[0];
    expect(call[0]).toBe(FALLBACK);
    expect(call[1]).toMatchObject({
      cancel: { label: "Report issue" },
    });
  });
});
