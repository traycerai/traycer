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
 * Boot-card escape hatch across a surface swap. jsdom dispatches `click` directly; Chromium emits none if the press target is removed before release.
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

/** Gate/narrator is a different React tree drawing the same card. Mirror DefaultHostReadyGate's column so a miss is not a layout shift. */
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

  // Install in an effect, never during render. A render-time module write is
  // a lint error and a concurrent-rendering hazard.
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

/** MockRunnerHost default (no CLI) hides the log disclosure; Open settings still renders. This fixture is the escape hatch, not the log. */
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
