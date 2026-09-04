import { cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import type {
  ProviderAuthStatus,
  ProviderCliState,
  ProviderId,
} from "@traycer/protocol/host/provider-schemas";
import type { GuiHarnessId } from "@traycer/protocol/host/index";
import { providerSignedOutMessage } from "@traycer/protocol/host/provider-display";
import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import {
  recordNegotiatedHostManifest,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import type { GuiHarnessCatalogEntry } from "@/hooks/harnesses/use-gui-harness-catalog";
import { PickerProviderAuthLine } from "../harness-model-picker-auth-line";

// The terminal action mounts a real mutation, so every render gets a client.
// Fresh per render: a mutation cached across cases would carry its pending
// state into the next one.
function renderAuthLine(ui: ReactNode) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>,
  );
}

// The HOST CLIENT is the only thing faked here - the external boundary. The
// real `useLandingProviderStartTerminalLogin` runs, so this file covers the
// wiring from the resolved setup through the button to the RPC, which a mock
// of that hook would hide. Its own response handling (which tab opens, which
// panel) is covered in `use-landing-provider-terminal-login.test.tsx`.
const HOST_ID = "host-1";

const mocks = vi.hoisted(() => ({
  startTerminalLoginRequest: vi.fn(),
}));

vi.mock("@/hooks/host/use-host-client-for-host-id", () => ({
  useHostClientForHostId: () => ({
    getActiveHostId: () => HOST_ID,
    request: mocks.startTerminalLoginRequest,
  }),
}));

// The picker passes `runTargetHostId={null}` (follow the app-wide default),
// which the scope gate resolves through this hook - so it has to name the same
// host the negotiated manifest below is recorded for.
vi.mock("@/hooks/host/use-addressable-host-id", () => ({
  useAddressableHostId: () => HOST_ID,
}));

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

// Overrides `loginCapability` with a terminal-login-capable shape - this is
// what `resolveProviderTerminalSetup` now gates the "setup" verdict on, so a
// test asserting the full guidance row must supply it explicitly rather than
// relying on the guidance table alone.
function withTerminalLoginCapability(
  state: ProviderCliState,
): ProviderCliState {
  return {
    ...state,
    loginCapability: {
      oauthArgs: ["setup"],
      token: null,
      codePaste: null,
      terminalLogin: {},
    },
  };
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
  beforeEach(() => {
    resetNegotiatedManifests();
    // A modern host: `providers.startTerminalLogin@2` is the first major that
    // carries a scope, and the landing action sends the independent one.
    recordNegotiatedHostManifest(HOST_ID, {
      "providers.startTerminalLogin": { major: 2, minor: 0 },
    });
  });

  afterEach(() => {
    cleanup();
    mocks.startTerminalLoginRequest.mockClear();
    resetNegotiatedManifests();
  });

  it("renders nothing when both state and harness are null (no provider identity to resolve)", () => {
    const { container } = renderAuthLine(
      <PickerProviderAuthLine
        state={null}
        harness={null}
        terminalLoginSurface={null}
        runTargetHostId={null}
        onClosePicker={() => undefined}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing for a disabled provider (enabled read off state)", () => {
    const { container } = renderAuthLine(
      <PickerProviderAuthLine
        state={disabledProviderState("reasonix")}
        harness={null}
        terminalLoginSurface={null}
        runTargetHostId={null}
        onClosePicker={() => undefined}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing when state is null and the harness itself is disabled (enabled falls back to harness.enabled)", () => {
    const { container } = renderAuthLine(
      <PickerProviderAuthLine
        state={null}
        harness={harnessOption("reasonix", false, "unauthenticated", null)}
        terminalLoginSurface={null}
        runTargetHostId={null}
        onClosePicker={() => undefined}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders the compact signed-out line when state is null for a provider with NO guidance override (claude-code), even though identity/enabled resolve from the harness", () => {
    renderAuthLine(
      <PickerProviderAuthLine
        state={null}
        harness={harnessOption("claude", true, "unauthenticated", null)}
        terminalLoginSurface={null}
        runTargetHostId={null}
        onClosePicker={() => undefined}
      />,
    );

    // No `providers.list` row and no copy-table override for this provider,
    // so `resolveProviderTerminalSetup` has nothing to preserve and this
    // stays the compact line rather than the full "Setup required" note.
    // (Reasonix is the one exception - see the capability-absent test below,
    // which covers exactly that provider on this same state:null path.)
    expect(screen.queryByRole("note", { name: "Setup required" })).toBeNull();
    expect(screen.getByText("Not authenticated")).toBeDefined();
  });

  it("renders the setup-guidance row (steps + manual-command sentence, no button) for a signed-out provider with guidance (reasonix)", () => {
    renderAuthLine(
      <PickerProviderAuthLine
        state={withTerminalLoginCapability(baseProviderState("reasonix"))}
        harness={null}
        terminalLoginSurface={null}
        runTargetHostId={null}
        onClosePicker={() => undefined}
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
      "Choose “Set up in terminal” from a chat's model picker or the start page's. It opens Reasonix's setup wizard on the host that composer runs on.",
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

  it("renders the setup-guidance row with steps + manual command but NO button when the capability is absent (loginCapability: null) - reasonix's override survives an old/unresolved host even with a surface available", () => {
    renderAuthLine(
      <PickerProviderAuthLine
        state={baseProviderState("reasonix")}
        harness={null}
        // A landing surface IS supplied, to prove the missing button is
        // `canStartTerminal: false`'s doing, not merely a null surface.
        terminalLoginSurface={{
          kind: "landing",
          resolveLandingPageId: () => "draft-1",
        }}
        runTargetHostId={null}
        onClosePicker={() => undefined}
      />,
    );

    const note = screen.getByRole("note", { name: "Setup required" });
    expect(
      screen.getByText(
        "Reasonix keeps provider API keys in its own store, not in your shell environment.",
      ),
    ).toBeDefined();

    // "unsupported-host" placement: the post-action steps alone, never the
    // no-surface sentence naming a button this host never declared.
    const list = note.querySelector("ol");
    const items = Array.from(list?.querySelectorAll("li") ?? []);
    expect(items.map((item) => item.textContent)).toEqual([
      "Paste your provider API key when asked (DeepSeek by default).",
      "Refresh this list.",
    ]);

    const code = note.querySelector("code");
    expect(code?.textContent).toBe("reasonix setup");

    expect(screen.queryByRole("button")).toBeNull();
    expect(mocks.startTerminalLoginRequest).not.toHaveBeenCalled();
  });

  it("renders the terminal action button when the capability is present and a landing surface is available", () => {
    renderAuthLine(
      <PickerProviderAuthLine
        state={withTerminalLoginCapability(baseProviderState("reasonix"))}
        harness={null}
        terminalLoginSurface={{
          kind: "landing",
          resolveLandingPageId: () => "draft-1",
        }}
        runTargetHostId={null}
        onClosePicker={() => undefined}
      />,
    );

    expect(
      screen.getByRole("button", { name: /Set up in terminal/ }),
    ).toBeDefined();
    // Capability present + a real surface here means "here" placement - the
    // no-surface sentence must not also render beside a real button.
    expect(
      screen.queryByText(
        "Choose “Set up in terminal” from a chat's model picker or the start page's. It opens Reasonix's setup wizard on the host that composer runs on.",
      ),
    ).toBeNull();
  });

  it("hides the landing action on a host that negotiated the pre-scope major, and says so in the steps", () => {
    resetNegotiatedManifests();
    recordNegotiatedHostManifest(HOST_ID, {
      "providers.startTerminalLogin": { major: 1, minor: 0 },
    });

    renderAuthLine(
      <PickerProviderAuthLine
        state={withTerminalLoginCapability(baseProviderState("reasonix"))}
        harness={null}
        terminalLoginSurface={{
          kind: "landing",
          resolveLandingPageId: () => "draft-1",
        }}
        runTargetHostId={null}
        onClosePicker={() => undefined}
      />,
    );

    // Identical props to the test above; only the host's negotiated major
    // differs. `@1.0` cannot carry the independent scope, so the request is
    // refused as `DOWNGRADE_UNSUPPORTED` - the button could only ever fail.
    expect(
      screen.queryByRole("button", { name: /Set up in terminal/ }),
    ).toBeNull();
    // And not the "it's on another surface" copy either: there is no surface
    // on this host that draws it, so the steps must lead with the manual
    // route rather than pointing at a button nobody can find.
    expect(
      screen.queryByText(
        "Choose \u201CSet up in terminal\u201D from a chat's model picker or the start page's. It opens Reasonix's setup wizard on the host that composer runs on.",
      ),
    ).toBeNull();
    expect(screen.getByRole("note", { name: "Setup required" })).toBeDefined();
  });

  it("shows the pack's preparing state instead of the button while the provider cannot spawn", () => {
    renderAuthLine(
      <PickerProviderAuthLine
        state={{
          ...withTerminalLoginCapability(baseProviderState("reasonix")),
          // Downloading with nothing to fall back to: the host's only answer
          // to `providers.startTerminalLogin` would be its `preparing` error.
          managedInstallState: { status: "downloading", percent: 30 },
        }}
        harness={null}
        terminalLoginSurface={{
          kind: "landing",
          resolveLandingPageId: () => "draft-1",
        }}
        runTargetHostId={null}
        onClosePicker={() => undefined}
      />,
    );

    expect(
      screen.queryByRole("button", { name: /Set up in terminal/ }),
    ).toBeNull();
    expect(screen.getByRole("status").textContent).toBe(
      "Preparing Reasonix… 30%",
    );
    // Not the manual-route copy either: this is a wait, not an old host.
    expect(screen.queryByText(/from a chat's model picker/)).toBeNull();
  });

  it("renders the bare 'Not authenticated' label for a signed-out provider without guidance", () => {
    renderAuthLine(
      <PickerProviderAuthLine
        state={baseProviderState("claude-code")}
        harness={null}
        terminalLoginSurface={null}
        runTargetHostId={null}
        onClosePicker={() => undefined}
      />,
    );

    expect(screen.getByText("Not authenticated")).toBeDefined();
    expect(screen.queryByRole("note", { name: "Setup required" })).toBeNull();
  });

  it("treats a signed-out harness row (authStatus: unauthenticated) as signed out even when the provider state is authenticated", () => {
    renderAuthLine(
      <PickerProviderAuthLine
        state={withTerminalLoginCapability(
          providerStateWithAuth(
            "reasonix",
            "authenticated",
            null,
            "Authenticated",
          ),
        )}
        harness={harnessOption("reasonix", true, "unauthenticated", null)}
        terminalLoginSurface={null}
        runTargetHostId={null}
        onClosePicker={() => undefined}
      />,
    );

    expect(screen.getByText("Not authenticated")).toBeDefined();
    expect(screen.getByRole("note", { name: "Setup required" })).toBeDefined();
  });

  it("renders only the compact 'Not authenticated' label - never the authenticated badge - when an authenticated state's harness reports the signed-out catalog error", () => {
    renderAuthLine(
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
        terminalLoginSurface={null}
        runTargetHostId={null}
        onClosePicker={() => undefined}
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
    renderAuthLine(
      <PickerProviderAuthLine
        state={withTerminalLoginCapability(baseProviderState("reasonix"))}
        harness={harnessOption(
          "reasonix",
          true,
          undefined,
          catalogErrorFor("agent.gui.listModels", "spawn failed: ENOENT"),
        )}
        terminalLoginSurface={null}
        runTargetHostId={null}
        onClosePicker={() => undefined}
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
    renderAuthLine(
      <PickerProviderAuthLine
        state={providerStateWithAuth(
          "claude-code",
          "authenticated",
          "GitHub CLI",
          "Authenticated as octocat",
        )}
        harness={null}
        terminalLoginSurface={null}
        runTargetHostId={null}
        onClosePicker={() => undefined}
      />,
    );

    expect(screen.getByText("GitHub CLI")).toBeDefined();
    expect(screen.getByText("Authenticated as octocat")).toBeDefined();
    expect(screen.queryByText("Not authenticated")).toBeNull();
  });

  it("renders the badge/label row for a configured provider", () => {
    renderAuthLine(
      <PickerProviderAuthLine
        state={providerStateWithAuth(
          "cursor",
          "configured",
          null,
          "API key configured",
        )}
        harness={null}
        terminalLoginSurface={null}
        runTargetHostId={null}
        onClosePicker={() => undefined}
      />,
    );

    expect(screen.getByText("API key configured")).toBeDefined();
  });

  it("renders nothing for an authenticated provider with no badge or label", () => {
    const { container } = renderAuthLine(
      <PickerProviderAuthLine
        state={providerStateWithAuth(
          "claude-code",
          "authenticated",
          null,
          null,
        )}
        harness={null}
        terminalLoginSurface={null}
        runTargetHostId={null}
        onClosePicker={() => undefined}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing for a non-definitive, non-configured auth status (e.g. unknown)", () => {
    const { container } = renderAuthLine(
      <PickerProviderAuthLine
        state={providerStateWithAuth(
          "claude-code",
          "unknown",
          "some badge",
          "some label",
        )}
        harness={null}
        terminalLoginSurface={null}
        runTargetHostId={null}
        onClosePicker={() => undefined}
      />,
    );
    expect(container.firstChild).toBeNull();
  });
});
