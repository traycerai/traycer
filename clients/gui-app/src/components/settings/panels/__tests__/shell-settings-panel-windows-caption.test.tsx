// The panel is host-scoped now (shell config / log levels are fields of the
// selected host's own config), so it reads `useHostScope`. Mock at that
// boundary: this suite renders the panel bare, without the host runtime and
// query providers the real hook needs.
const scopeOverrides = vi.hoisted((): { current: Record<string, unknown> } => ({
  current: {},
}));
vi.mock("@/components/settings/host-scope/use-host-scope", async () => {
  const { hostScopeFixture } =
    await import("@/components/settings/host-scope/host-scope-fixture");
  return {
    useHostScope: () => hostScopeFixture(scopeOverrides.current),
  };
});

const hostBindingMock = vi.hoisted(
  (): { current: { readonly hostClient: unknown } | null } => ({
    current: null,
  }),
);
vi.mock("@/lib/host", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/host")>();
  return { ...actual, useHostBinding: () => hostBindingMock.current };
});

import { cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { IRunnerHost } from "@traycer-clients/shared/platform/runner-host";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import {
  recordNegotiatedHostMethods,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import { hostScopeOptionFixture } from "@/components/settings/host-scope/host-scope-fixture";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import { ShellSettingsPanel } from "@/components/settings/panels/shell-settings-panel";
import {
  CONFIG_SHELL_METHODS,
  buildConfigHostFixture,
} from "@/components/settings/panels/__tests__/host-config-rpc-test-support";

// `isWindows()` is computed once at module load from UA hints, so the host
// platform is faked through a togglable mock rather than a per-test navigator
// tweak. The rest of the module (mac/modifier helpers) stays real.
const platformState = vi.hoisted(() => ({ windows: true }));
vi.mock("@/lib/keybindings/platform", async (importActual) => ({
  ...(await importActual<typeof import("@/lib/keybindings/platform")>()),
  isWindows: () => platformState.windows,
}));

afterEach(() => {
  cleanup();
  platformState.windows = true;
  resetNegotiatedManifests();
  scopeOverrides.current = {};
  hostBindingMock.current = null;
});

function renderPanel(path: string): void {
  const hostId = "host-a";
  const fixture = buildConfigHostFixture({ hostId, isLocalMachine: true });
  fixture.cli.shellConfig = { path, args: [], synthesised: false };
  recordNegotiatedHostMethods(hostId, CONFIG_SHELL_METHODS);

  scopeOverrides.current = {
    host: hostScopeOptionFixture({
      hostId,
      isLocalMachine: true,
      connectable: true,
    }),
    hostId,
    status: "ready",
    client: fixture.client,
  };
  hostBindingMock.current = { hostClient: fixture.client };

  const runnerHost: IRunnerHost = new MockRunnerHost({
    signInUrl: "https://example.invalid/signin",
    authnBaseUrl: "https://example.invalid",
    localHost: null,
    hosts: [],
    workspaceFolderPickerPaths: undefined,
    hasLocalHost: undefined,
    traycerCli: undefined,
  });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <RunnerHostProvider runnerHost={runnerHost}>
        <ShellSettingsPanel />
      </RunnerHostProvider>
    </QueryClientProvider>,
  );
}

const WSL_CAPTION = /WSL applies to terminal tabs only/;

describe("<ShellSettingsPanel /> WSL agent caption", () => {
  it("shows the one-line caption for wsl.exe, with the remedy in a hover card", async () => {
    renderPanel("C:\\Windows\\System32\\wsl.exe");
    expect(await screen.findByText(WSL_CAPTION)).toBeTruthy();
    // The remedy prose stays out of the inline caption - hover card only.
    expect(screen.queryByText(/does not move the Traycer host/)).toBeNull();
  });

  it("exposes the WSL remedy as a keyboard-focusable docs link", async () => {
    renderPanel("C:\\Windows\\System32\\wsl.exe");
    await screen.findByText(WSL_CAPTION);
    // The hover card is pointer-only; the docs link must ALSO exist in the
    // sequential tab order - the caption's Info glyph is a real anchor.
    const link = screen.getByRole("link", { name: /install Traycer in WSL/i });
    expect(link.getAttribute("href")).toBe(
      "https://docs.traycer.ai/install#windows-via-wsl",
    );
  });

  it("renders no WSL docs link for other shells", async () => {
    renderPanel("C:\\Windows\\System32\\cmd.exe");
    await screen.findByText("Startup flags for cmd.exe");
    expect(
      screen.queryByRole("link", { name: /install Traycer in WSL/i }),
    ).toBeNull();
  });

  it("shows no caption for PowerShell (profile loading is expected behavior)", async () => {
    renderPanel("C:\\Program Files\\PowerShell\\7\\pwsh.exe");
    await screen.findByText("Startup flags for pwsh.exe");
    expect(screen.queryByText(WSL_CAPTION)).toBeNull();
  });

  it("shows no caption for a Git-install bash", async () => {
    renderPanel("C:\\Program Files\\Git\\bin\\bash.exe");
    await screen.findByText("Startup flags for bash.exe");
    expect(screen.queryByText(WSL_CAPTION)).toBeNull();
  });

  it("shows no caption for cmd", async () => {
    renderPanel("C:\\Windows\\System32\\cmd.exe");
    await screen.findByText("Startup flags for cmd.exe");
    expect(screen.queryByText(WSL_CAPTION)).toBeNull();
  });

  it("shows no caption on a non-Windows host, even for a wsl-named path", async () => {
    platformState.windows = false;
    renderPanel("/bin/zsh");
    await screen.findByText("Startup flags for zsh");
    expect(screen.queryByText(WSL_CAPTION)).toBeNull();
  });
});
