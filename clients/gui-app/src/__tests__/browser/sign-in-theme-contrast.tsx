import { useEffect, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import { AuthLandingPage } from "@/components/auth/auth-landing-page";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { AuthService } from "@/lib/auth/auth-service";
import {
  hostRpcRegistry,
  HostRuntimeProvider,
  useAuthService,
  type HostRpcRegistry,
} from "@/lib/host";
import { setMobileApp } from "@/lib/mobile-app";
import { THEME_PRESETS, type ThemePreset } from "@/lib/theme-presets";
import "@/lib/theme-applier";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useDesktopDialogStore } from "@/stores/dialogs/desktop-dialog-store";
import { useSettingsStore } from "@/stores/settings/settings-store";
import "@/index.css";

/**
 * THE SIGN-IN PAGE UNDER EVERY THEME: the real `AuthLandingPage`, in one of
 * its states (`?state=<name>`), with the theme switched live by the real
 * theme applier through `window.__probeTheme(mode, preset)`.
 *
 * The page paints a fixed dark ground while its controls resolve colours from
 * theme tokens, so whether a label is legible is a question about the RENDERED
 * colours under a given theme - which jsdom, with no cascade and no pixels,
 * cannot answer. `scripts/sign-in-theme-contrast-browser.mjs` drives this
 * fixture, reads each label's colour against the pixels behind it, and
 * asserts the contrast under every preset in both appearances.
 *
 * Every control is production code with production providers; the host is
 * `MockRunnerHost`, whose device flow is what the device-progress and error
 * states are driven through - the same way the jsdom suites drive them.
 */
const STATES = [
  "desktop-rest",
  "desktop-device",
  "desktop-error",
  "desktop-refusal",
  "mobile-rest",
  "mobile-manual",
  "mobile-manual-error",
  "mobile-claim",
  "mobile-refusal",
  "splash",
] as const;
type ProbeState = (typeof STATES)[number];

const params = new URLSearchParams(location.search);
const requested = params.get("state");
const state: ProbeState =
  STATES.find((candidate) => candidate === requested) ?? "desktop-rest";

setMobileApp(state.startsWith("mobile-"));
// The error row offers `Report issue` when the shell can file one; shown so
// the link is measured the way a desktop user sees it.
useDesktopDialogStore.getState().setReportIssueAvailable(true);

interface ProbeWindow extends Window {
  __probeStates?: ReadonlyArray<string>;
  __probePresets?: ReadonlyArray<ThemePreset>;
  __probeTheme?: (mode: "light" | "dark", preset: ThemePreset) => void;
  __probeReady?: boolean;
}
const probeWindow: ProbeWindow = window;
probeWindow.__probeStates = STATES;
probeWindow.__probePresets = THEME_PRESETS.map((preset) => preset.id);
probeWindow.__probeTheme = (mode, preset) => {
  useSettingsStore.getState().setTheme(mode);
  useSettingsStore.getState().setThemePreset(preset);
};

const host = new MockRunnerHost({
  signInUrl: "https://auth.traycer.invalid/sign-in",
  authnBaseUrl: "http://127.0.0.1:9",
  localHost: null,
  hosts: [],
  workspaceFolderPickerPaths: undefined,
  hasLocalHost: undefined,
  traycerCli: undefined,
});

function messengerFactory(args: {
  registry: HostRpcRegistry;
}): MockHostMessenger<HostRpcRegistry> {
  return new MockHostMessenger<HostRpcRegistry>({
    registry: args.registry,
    requestId: () => "req-1",
    handlers: {},
  });
}

async function driveState(auth: AuthService): Promise<void> {
  switch (state) {
    case "desktop-device":
      await auth.signIn();
      return;
    case "desktop-error":
      await auth.signIn();
      host.deviceFlow.emitResult({ kind: "error" });
      return;
    case "mobile-claim":
      // A link claim awaiting the desktop's approval: every entry point is
      // disabled and the wait block shows.
      useAuthStore.setState({ status: "signing-in", signingInAttempt: "link" });
      return;
    case "desktop-rest":
    case "desktop-refusal":
    case "mobile-rest":
    case "mobile-manual":
    case "mobile-manual-error":
    case "mobile-refusal":
    case "splash":
      return;
  }
}

export function DriveState(): null {
  const auth = useAuthService();
  useEffect(() => {
    void driveState(auth).then(() => {
      probeWindow.__probeReady = true;
    });
  }, [auth]);
  return null;
}

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false } },
});

export function SignInThemeContrastFixture(): ReactElement {
  return (
    <RunnerHostProvider runnerHost={host}>
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <HostRuntimeProvider
            registry={hostRpcRegistry}
            messengerFactory={messengerFactory}
            invalidator={null}
            requestId={null}
            remoteFetcher={() =>
              Promise.resolve({ kind: "hosts", entries: [] })
            }
            fallback={<div data-testid="runtime-fallback" />}
          >
            <DriveState />
            <AuthLandingPage
              refusal={
                state.endsWith("-refusal") ? "unverified-relay-only" : null
              }
            />
          </HostRuntimeProvider>
        </TooltipProvider>
      </QueryClientProvider>
    </RunnerHostProvider>
  );
}

const container = document.querySelector("#root");
if (container === null) throw new Error("probe root missing");
createRoot(container).render(<SignInThemeContrastFixture />);
