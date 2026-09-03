import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
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

function noop(): void {}

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
  authStatus: ProviderAuthStatus | undefined,
  modelsError: HostRpcError | null,
): GuiHarnessCatalogEntry {
  return {
    id,
    label: id,
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

  it("renders nothing for a null state", () => {
    const { container } = render(
      <PickerProviderAuthLine
        state={null}
        harness={null}
        onOpenProviderSettings={noop}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing for a disabled provider", () => {
    const { container } = render(
      <PickerProviderAuthLine
        state={disabledProviderState("reasonix")}
        harness={null}
        onOpenProviderSettings={noop}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders the setup-guidance row for a signed-out provider with guidance (reasonix)", () => {
    const onOpenProviderSettings = vi.fn();
    render(
      <PickerProviderAuthLine
        state={baseProviderState("reasonix")}
        harness={null}
        onOpenProviderSettings={onOpenProviderSettings}
      />,
    );

    const note = screen.getByRole("note", { name: "Setup required" });
    expect(note).toBeDefined();
    expect(screen.getByText("Not authenticated")).toBeDefined();
    expect(
      screen.getByText(
        "Reasonix keeps provider API keys in its own store, not in your shell environment.",
      ),
    ).toBeDefined();

    // First ordered-list item names the command in a <code> element.
    const list = note.querySelector("ol");
    expect(list).not.toBeNull();
    const items = list?.querySelectorAll("li") ?? [];
    expect(items.length).toBe(3);
    const code = items[0]?.querySelector("code");
    expect(code?.textContent).toBe("reasonix setup");
    expect(items[1]?.textContent).toBe(
      "Paste your provider API key when asked (DeepSeek by default).",
    );
    expect(items[2]?.textContent).toBe("Refresh this list.");

    fireEvent.click(screen.getByRole("button", { name: "Open Settings" }));
    expect(onOpenProviderSettings).toHaveBeenCalledTimes(1);
  });

  it("renders the bare 'Not authenticated' label for a signed-out provider without guidance", () => {
    render(
      <PickerProviderAuthLine
        state={baseProviderState("claude-code")}
        harness={null}
        onOpenProviderSettings={noop}
      />,
    );

    expect(screen.getByText("Not authenticated")).toBeDefined();
    expect(screen.queryByRole("note", { name: "Setup required" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Open Settings" })).toBeNull();
  });

  it("treats a signed-out harness row (authStatus: unauthenticated) as signed out even when the provider state is authenticated", () => {
    const onOpenProviderSettings = vi.fn();
    render(
      <PickerProviderAuthLine
        state={providerStateWithAuth(
          "reasonix",
          "authenticated",
          null,
          "Authenticated",
        )}
        harness={harnessOption("reasonix", "unauthenticated", null)}
        onOpenProviderSettings={onOpenProviderSettings}
      />,
    );

    expect(screen.getByText("Not authenticated")).toBeDefined();
    expect(screen.getByRole("note", { name: "Setup required" })).toBeDefined();
  });

  it("renders only the compact 'Not authenticated' label (no steps, no button) when the model list already shows the signed-out CTA", () => {
    const onOpenProviderSettings = vi.fn();
    render(
      <PickerProviderAuthLine
        state={baseProviderState("reasonix")}
        harness={harnessOption(
          "reasonix",
          undefined,
          catalogErrorFor(
            "agent.gui.listModels",
            providerSignedOutMessage("reasonix"),
          ),
        )}
        onOpenProviderSettings={onOpenProviderSettings}
      />,
    );

    expect(screen.getByText("Not authenticated")).toBeDefined();
    expect(screen.queryByRole("note", { name: "Setup required" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Open Settings" })).toBeNull();
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
          undefined,
          catalogErrorFor("agent.gui.listModels", "spawn failed: ENOENT"),
        )}
        onOpenProviderSettings={noop}
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
        onOpenProviderSettings={noop}
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
        onOpenProviderSettings={noop}
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
        onOpenProviderSettings={noop}
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
        onOpenProviderSettings={noop}
      />,
    );
    expect(container.firstChild).toBeNull();
  });
});
