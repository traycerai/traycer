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
import type {
  IRunnerHost,
  TraycerDetectedShell,
} from "@traycer-clients/shared/platform/runner-host";
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

function renderPanel(
  path: string,
  detectedShells: readonly TraycerDetectedShell[] | undefined,
): void {
  const hostId = "host-a";
  const fixture = buildConfigHostFixture({ hostId, isLocalMachine: true });
  fixture.cli.shellConfig = { path, args: [], synthesised: false };
  if (detectedShells !== undefined) {
    fixture.cli.detectedShells = detectedShells;
  }
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
const WSL_PATH = "C:\\Windows\\System32\\wsl.exe";

/** The picker list as a Windows host reports it when its WSL cannot run. */
function brokenWslShells(
  health: NonNullable<TraycerDetectedShell["wslHealth"]>,
): readonly TraycerDetectedShell[] {
  return [
    {
      name: "WSL",
      path: WSL_PATH,
      isDefault: false,
      source: "detected",
      missing: false,
      wslHealth: health,
    },
  ];
}

describe("<ShellSettingsPanel /> WSL agent caption", () => {
  it("shows the one-line caption for wsl.exe, with the remedy in a hover card", async () => {
    renderPanel("C:\\Windows\\System32\\wsl.exe", undefined);
    expect(await screen.findByText(WSL_CAPTION)).toBeTruthy();
    // The remedy prose stays out of the inline caption - hover card only.
    expect(screen.queryByText(/does not move the Traycer host/)).toBeNull();
  });

  it("escalates to the terminals-won't-start caption when the host flags WSL", async () => {
    renderPanel(WSL_PATH, brokenWslShells("not-installed"));
    expect(
      await screen.findByText(/WSL isn't installed — terminals won't start/),
    ).toBeTruthy();
    // The escalated caption REPLACES the quiet scoping note rather than
    // stacking with it: one line under the picker, the more urgent one.
    expect(screen.queryByText(WSL_CAPTION)).toBeNull();
  });

  it("names the missing distribution when WSL itself runs", async () => {
    renderPanel(WSL_PATH, brokenWslShells("no-distro"));
    expect(
      await screen.findByText(
        /WSL has no Linux distribution — terminals won't start/,
      ),
    ).toBeTruthy();
  });

  it("still warns when a non-Windows GUI configures a Windows host", async () => {
    // The regression this guards: `isWindows()` reads the RENDERER's platform,
    // so a macOS/Linux app driving a remote Windows host would hide the
    // warning. `wslHealth` is computed on the host, so it must not be gated on
    // the renderer at all.
    platformState.windows = false;
    renderPanel(WSL_PATH, brokenWslShells("not-installed"));
    expect(
      await screen.findByText(/WSL isn't installed — terminals won't start/),
    ).toBeTruthy();
  });

  it("keeps the quiet scoping note when the host reports a healthy WSL", async () => {
    renderPanel(WSL_PATH, undefined);
    expect(await screen.findByText(WSL_CAPTION)).toBeTruthy();
    expect(screen.queryByText(/terminals won't start/)).toBeNull();
  });

  it("exposes the WSL remedy as a keyboard-focusable docs link", async () => {
    renderPanel("C:\\Windows\\System32\\wsl.exe", undefined);
    await screen.findByText(WSL_CAPTION);
    // The hover card is pointer-only; the docs link must ALSO exist in the
    // sequential tab order - the caption's Info glyph is a real anchor.
    const link = screen.getByRole("link", { name: /install Traycer in WSL/i });
    expect(link.getAttribute("href")).toBe(
      "https://docs.traycer.ai/install#windows-via-wsl",
    );
  });

  it("renders no WSL docs link for other shells", async () => {
    renderPanel("C:\\Windows\\System32\\cmd.exe", undefined);
    await screen.findByText("Startup flags for cmd.exe");
    expect(
      screen.queryByRole("link", { name: /install Traycer in WSL/i }),
    ).toBeNull();
  });

  it("shows no caption for PowerShell (profile loading is expected behavior)", async () => {
    renderPanel("C:\\Program Files\\PowerShell\\7\\pwsh.exe", undefined);
    await screen.findByText("Startup flags for pwsh.exe");
    expect(screen.queryByText(WSL_CAPTION)).toBeNull();
  });

  it("shows no caption for a Git-install bash", async () => {
    renderPanel("C:\\Program Files\\Git\\bin\\bash.exe", undefined);
    await screen.findByText("Startup flags for bash.exe");
    expect(screen.queryByText(WSL_CAPTION)).toBeNull();
  });

  it("shows no caption for cmd", async () => {
    renderPanel("C:\\Windows\\System32\\cmd.exe", undefined);
    await screen.findByText("Startup flags for cmd.exe");
    expect(screen.queryByText(WSL_CAPTION)).toBeNull();
  });

  it("shows no caption on a non-Windows host, even for a wsl-named path", async () => {
    platformState.windows = false;
    renderPanel("/bin/zsh", undefined);
    await screen.findByText("Startup flags for zsh");
    expect(screen.queryByText(WSL_CAPTION)).toBeNull();
  });
});
