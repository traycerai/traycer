import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type {
  ProviderAuthStatus,
  ProviderCliState,
  ProviderId,
} from "@traycer/protocol/host/provider-schemas";
import type { GuiHarnessId } from "@traycer/protocol/host/index";
import { providerSignedOutMessage } from "@traycer/protocol/host/provider-display";
import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type { GuiHarnessCatalogEntry } from "@/hooks/harnesses/use-gui-harness-catalog";
import { PickerProviderAuthLine } from "../harness-model-picker-auth-line";

function baseProviderState(providerId: ProviderId): ProviderCliState {
  return {
    providerId,
    enabled: true,
    disabledBy: null,
    selected: { kind: "bundled" },
    candidates: [],
    auth: {
      status: "unauthenticated",
      badgeText: null,
      label: null,
      detail: null,
    },
    authPending: false,
    checkedAt: null,
    apiKey: { supported: false, configured: false, source: null },
    terminalAgentArgs: "",
    envOverrides: [],
    loginCapability: null,
    availabilityPending: false,
    nativeCapabilities: {
      supportedTabs: ["general", "env", "usage"],
      mcp: null,
      plugins: null,
      skills: null,
      modelProviders: null,
    },
    managedInstallState: null,
    versionVisibility: null,
    advisory: null,
    profiles: [],
  };
}

function providerStateWithAuth(
  providerId: ProviderId,
  status: ProviderAuthStatus,
  badgeText: string | null,
  label: string | null,
): ProviderCliState {
  return {
    ...baseProviderState(providerId),
    auth: { status, badgeText, label, detail: null },
  };
}

function disabledProviderState(providerId: ProviderId): ProviderCliState {
  return { ...baseProviderState(providerId), enabled: false };
}

function harnessOption(
  id: GuiHarnessId,
  enabled: boolean,
  authStatus: ProviderAuthStatus | undefined,
  modelsError: HostRpcError | null,
): GuiHarnessCatalogEntry {
  return {
    id,
    label: id,
    enabled,
    available: true,
    error: null,
    modes: ["gui"],
    requiresApiKey: false,
    supportedPermissionModes: [
      "supervised",
      "auto_accept_edits",
      "full_access",
    ],
    availabilityPending: false,
    authStatus,
    models: [],
    modelsLoading: false,
    modelsError,
  };
}

function catalogErrorFor(
  method: "agent.gui.listModels",
  message: string,
): HostRpcError {
  return new HostRpcError({
    code: "RPC_ERROR",
    message,
    requestId: "req-1",
    method,
    fatalDetails: null,
  });
}

describe("<PickerProviderAuthLine />", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders nothing when both state and harness are null (no provider identity to resolve)", () => {
    const { container } = render(
      <PickerProviderAuthLine state={null} harness={null} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing for a disabled provider (enabled read off state)", () => {
    const { container } = render(
      <PickerProviderAuthLine
        state={disabledProviderState("reasonix")}
        harness={null}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing when state is null and the harness itself is disabled (enabled falls back to harness.enabled)", () => {
    const { container } = render(
      <PickerProviderAuthLine
        state={null}
        harness={harnessOption("reasonix", false, "unauthenticated", null)}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders the signed-out guidance line when state is null but an enabled harness row reports unauthenticated (provider identity and enabled both resolved from the harness)", () => {
    render(
      <PickerProviderAuthLine
        state={null}
        harness={harnessOption("reasonix", true, "unauthenticated", null)}
      />,
    );

    expect(screen.getByRole("note", { name: "Setup required" })).toBeDefined();
    expect(screen.getByText("Not authenticated")).toBeDefined();
  });

  it("renders the setup-guidance row (steps + manual-command sentence, no button) for a signed-out provider with guidance (reasonix)", () => {
    render(
      <PickerProviderAuthLine
        state={baseProviderState("reasonix")}
        harness={null}
      />,
    );

    const note = screen.getByRole("note", { name: "Setup required" });
    expect(screen.getByText("Not authenticated")).toBeDefined();
    expect(
      screen.getByText(
        "Reasonix keeps provider API keys in its own store, not in your shell environment.",
      ),
    ).toBeDefined();

    // Steps render verbatim - no injected "Run … in a terminal" item.
    const list = note.querySelector("ol");
    expect(list).not.toBeNull();
    const items = Array.from(list?.querySelectorAll("li") ?? []);
    expect(items.map((item) => item.textContent)).toEqual([
      "From a chat, choose “Set up in terminal” in the banner above the composer. It opens Reasonix's setup wizard on the host this composer runs on.",
      "Paste your provider API key when asked (DeepSeek by default).",
      "Refresh this list.",
    ]);

    // The manual-command sentence names the command in a <code>.
    const code = note.querySelector("code");
    expect(code?.textContent).toBe("reasonix setup");
    expect(code?.closest("span")?.textContent).toBe(
      "Installed the CLI yourself? Running reasonix setup in your own terminal on that machine does the same.",
    );

    expect(screen.queryByRole("button", { name: "Open Settings" })).toBeNull();
  });

  it("renders the bare 'Not authenticated' label for a signed-out provider without guidance", () => {
    render(
      <PickerProviderAuthLine
        state={baseProviderState("claude-code")}
        harness={null}
      />,
    );

    expect(screen.getByText("Not authenticated")).toBeDefined();
    expect(screen.queryByRole("note", { name: "Setup required" })).toBeNull();
  });

  it("treats a signed-out harness row (authStatus: unauthenticated) as signed out even when the provider state is authenticated", () => {
    render(
      <PickerProviderAuthLine
        state={providerStateWithAuth(
          "reasonix",
          "authenticated",
          null,
          "Authenticated",
        )}
        harness={harnessOption("reasonix", true, "unauthenticated", null)}
      />,
    );

    expect(screen.getByText("Not authenticated")).toBeDefined();
    expect(screen.getByRole("note", { name: "Setup required" })).toBeDefined();
  });

  it("renders only the compact 'Not authenticated' label - never the authenticated badge - when an authenticated state's harness reports the signed-out catalog error", () => {
    render(
      <PickerProviderAuthLine
        state={providerStateWithAuth(
          "reasonix",
          "authenticated",
          "some badge",
          "Authenticated",
        )}
        harness={harnessOption(
          "reasonix",
          true,
          undefined,
          catalogErrorFor(
            "agent.gui.listModels",
            providerSignedOutMessage("reasonix"),
          ),
        )}
      />,
    );

    expect(screen.getByText("Not authenticated")).toBeDefined();
    expect(screen.queryByRole("note", { name: "Setup required" })).toBeNull();
    expect(screen.queryByText("Authenticated")).toBeNull();
    expect(screen.queryByText("some badge")).toBeNull();
    expect(
      screen.queryByText(
        "Reasonix keeps provider API keys in its own store, not in your shell environment.",
      ),
    ).toBeNull();
  });

  it("still renders the full guidance when the model list's error is NOT the signed-out message", () => {
    render(
      <PickerProviderAuthLine
        state={baseProviderState("reasonix")}
        harness={harnessOption(
          "reasonix",
          true,
          undefined,
          catalogErrorFor("agent.gui.listModels", "spawn failed: ENOENT"),
        )}
      />,
    );

    expect(screen.getByRole("note", { name: "Setup required" })).toBeDefined();
    expect(
      screen.getByText(
        "Reasonix keeps provider API keys in its own store, not in your shell environment.",
      ),
    ).toBeDefined();
  });

  it("renders the badge/label row for an authenticated provider", () => {
    render(
      <PickerProviderAuthLine
        state={providerStateWithAuth(
          "claude-code",
          "authenticated",
          "GitHub CLI",
          "Authenticated as octocat",
        )}
        harness={null}
      />,
    );

    expect(screen.getByText("GitHub CLI")).toBeDefined();
    expect(screen.getByText("Authenticated as octocat")).toBeDefined();
    expect(screen.queryByText("Not authenticated")).toBeNull();
  });

  it("renders the badge/label row for a configured provider", () => {
    render(
      <PickerProviderAuthLine
        state={providerStateWithAuth(
          "cursor",
          "configured",
          null,
          "API key configured",
        )}
        harness={null}
      />,
    );

    expect(screen.getByText("API key configured")).toBeDefined();
  });

  it("renders nothing for an authenticated provider with no badge or label", () => {
    const { container } = render(
      <PickerProviderAuthLine
        state={providerStateWithAuth(
          "claude-code",
          "authenticated",
          null,
          null,
        )}
        harness={null}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing for a non-definitive, non-configured auth status (e.g. unknown)", () => {
    const { container } = render(
      <PickerProviderAuthLine
        state={providerStateWithAuth(
          "claude-code",
          "unknown",
          "some badge",
          "some label",
        )}
        harness={null}
      />,
    );
    expect(container.firstChild).toBeNull();
  });
});
