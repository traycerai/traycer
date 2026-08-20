import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import { HostBootSurface } from "@/components/host/host-boot-surface";
import { HostRuntimeBootFallback } from "@/components/host/host-runtime-boot-fallback";
import { APP_HEADER_HEIGHT_CLASS } from "@/components/layout/header/app-header-height";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import { cn } from "@/lib/utils";
import "@/index.css";

/**
 * Browser fixture for the boot card's escape hatch surviving a surface swap.
 *
 * WHY IT CANNOT BE A JSDOM TEST. The defect is a browser INPUT-DISPATCH fact:
 * when the element a press started on is removed from the document before
 * release, Chromium emits no `click` at all, so `onClick` never runs. Testing
 * Library dispatches `click` directly, so the broken build passes every jsdom
 * test ever written for this button. The only instrument that can see it is a
 * real browser driven through `Input.dispatchMouseEvent` - see
 * `scripts/boot-escape-hatch-press-browser.mjs`.
 *
 * The shape reproduced here is the measured one, from a CDP capture of a real
 * user press on the production card:
 *
 *   pointerdown -> button[host-boot-open-settings]
 *   mousedown   -> button[host-boot-open-settings]
 *   ... the launch hands off to the next boot surface ...
 *   mouseup     -> the tree that replaced it
 *   (no click)
 *
 * WHAT IS REAL: the button and both cards are production components
 * (`HostRuntimeBootFallback` -> `HostBootSurface` -> `BootOpenSettingsButton`).
 * The two phases are the two REAL surfaces a launch crosses, drawn the way
 * their owners draw them, so the swap unmounts a real card and mounts a real
 * one rather than shuffling a stand-in. Only the trigger is synthetic: the
 * driver calls `swap()` where a launch would advance on its own.
 */

let activations = 0;
let capturedButton: Element | null = null;

interface BootEscapeHatchProbe {
  readonly activations: () => number;
  readonly reset: () => void;
  readonly swap: () => void;
  readonly captureButton: () => boolean;
  readonly capturedIsConnected: () => boolean;
}

declare global {
  interface Window {
    __bootEscapeHatchProbe: BootEscapeHatchProbe;
  }
}

/**
 * The gate/narrator phase: a DIFFERENT React tree drawing the same card, which
 * is precisely what makes the swap invisible to a user and fatal to a press.
 * The frame mirrors `DefaultHostReadyGate`'s column so the card lands in the
 * same place - a card that moved would let a driver "miss" the button for
 * ordinary layout reasons and call it a regression.
 */
export function GatePhase(props: { readonly onOpenSettings: () => void }) {
  return (
    <div className="flex min-h-svh w-full flex-col bg-background text-foreground">
      <div aria-hidden className={cn("shrink-0", APP_HEADER_HEIGHT_CLASS)} />
      <div className="flex flex-1 items-center justify-center p-6">
        <HostBootSurface
          testId="host-gate-attach-pending"
          onConfigureShell={() => undefined}
          onOpenSettings={props.onOpenSettings}
        />
      </div>
    </div>
  );
}

export function Fixture() {
  const [phase, setPhase] = useState<"runtime" | "gate">("runtime");
  const [generation, setGeneration] = useState<number>(0);

  const onOpenSettings = (): void => {
    activations += 1;
  };

  // Installed in an EFFECT, never during render: the driver only needs the
  // handle once the tree is on screen, and a render-time write to a
  // module-scoped binding is both a lint error here and a real hazard under
  // concurrent rendering.
  useEffect(() => {
    window.__bootEscapeHatchProbe = {
      activations: () => activations,
      reset: () => {
        activations = 0;
        capturedButton = null;
        setPhase("runtime");
        setGeneration((current) => current + 1);
      },
      swap: () => {
        setPhase("gate");
      },
      captureButton: () => {
        capturedButton = document.querySelector(
          '[data-testid="host-boot-open-settings"]',
        );
        return capturedButton !== null;
      },
      capturedIsConnected: () =>
        capturedButton !== null && capturedButton.isConnected,
    };
  }, []);

  // `key` on the phase, so React cannot reconcile the two surfaces into one
  // set of DOM nodes and quietly keep the pressed element alive - which would
  // make this fixture pass against the very defect it exists to catch.
  return phase === "runtime" ? (
    <HostRuntimeBootFallback
      key={`runtime-${String(generation)}`}
      onConfigureShell={() => undefined}
      onOpenSettings={onOpenSettings}
    />
  ) : (
    <GatePhase
      key={`gate-${String(generation)}`}
      onOpenSettings={onOpenSettings}
    />
  );
}

/**
 * The provider stack the boot body needs, and no more: the bootstrap-log
 * disclosure reads `traycer host status` through the runner host and its
 * TanStack query. A shell with no CLI (`MockRunnerHost`'s default) is the
 * honest configuration here - the disclosure self-hides, `Open settings`
 * still renders, and this fixture is about the escape hatch, not the log.
 */
const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false } },
});

function buildRunnerHost(): MockRunnerHost {
  return new MockRunnerHost({
    signInUrl: "https://auth.traycer.invalid/sign-in",
    authnBaseUrl: "http://localhost:5005",
    localHost: null,
    hosts: [],
    workspaceFolderPickerPaths: undefined,
    hasLocalHost: undefined,
    traycerCli: undefined,
  });
}

const container = document.getElementById("root");
if (container === null) throw new Error("#root element not found");
createRoot(container).render(
  <QueryClientProvider client={queryClient}>
    <RunnerHostProvider runnerHost={buildRunnerHost()}>
      <Fixture />
    </RunnerHostProvider>
  </QueryClientProvider>,
);
