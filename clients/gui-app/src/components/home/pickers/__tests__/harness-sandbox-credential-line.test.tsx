import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { GuiHarnessSandboxCredentialMode } from "@traycer/protocol/host/agent/gui/unary-schemas";
import type { GuiHarnessCatalogEntry } from "@/hooks/harnesses/use-gui-harness-catalog";
import { PickerSandboxCredentialLine } from "../harness-sandbox-credential-line";

afterEach(cleanup);

function harnessWith(
  mode: GuiHarnessSandboxCredentialMode | null,
  note: string | null,
): GuiHarnessCatalogEntry {
  return {
    id: "claude",
    label: "claude",
    enabled: true,
    available: true,
    error: null,
    modes: ["gui"],
    requiresApiKey: false,
    supportedPermissionModes: [
      "supervised",
      "auto_accept_edits",
      "full_access",
    ],
    nativeAutoJudge: false,
    availabilityPending: false,
    authStatus: undefined,
    sandboxCredentialMode: mode,
    sandboxCredentialNote: note,
    models: [],
    modelsLoading: false,
    modelsError: null,
  };
}

describe("<PickerSandboxCredentialLine />", () => {
  it("renders nothing for a null harness", () => {
    render(<PickerSandboxCredentialLine harness={null} />);
    expect(screen.queryByTestId("picker-sandbox-credential-line")).toBeNull();
  });

  it("renders nothing for a harness that reports no mode", () => {
    render(<PickerSandboxCredentialLine harness={harnessWith(null, null)} />);
    expect(screen.queryByTestId("picker-sandbox-credential-line")).toBeNull();
  });

  it.each([
    ["placeholder", "plain"],
    ["process-scoped", "caution"],
    ["unsupported", "unavailable"],
  ] as const)("renders the %s mode in the %s tone", (mode, tone) => {
    render(<PickerSandboxCredentialLine harness={harnessWith(mode, null)} />);

    const line = screen.getByTestId("picker-sandbox-credential-line");
    expect(line.getAttribute("data-tone")).toBe(tone);
    expect(line.textContent).not.toBe("");
  });
});
