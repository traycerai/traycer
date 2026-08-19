import type { ReactElement, ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  MockRunnerHost,
  MockTraycerCli,
} from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import { HostRuntimeBootFallback } from "@/components/host/host-runtime-boot-fallback";
import {
  BootOpenSettingsButton,
  HostBootSurface,
} from "@/components/host/host-boot-surface";
import { LocalBootstrapAttempts } from "@/components/host/local-bootstrap-attempts";
import { APP_HEADER_HEIGHT_CLASS } from "@/components/layout/header/app-header-height";
import {
  WindowHostModal,
  WindowHostStartupCard,
  type WindowHostModalProps,
} from "@/components/layout/dialogs/window-host-modal";
import { SurfaceReadinessFallback } from "@/components/layout/host-readiness-controller";
import {
  HostReadinessControllerContext,
  type DefaultHostReadinessPresentation,
  type GateDrawnReadiness,
} from "@/components/layout/host-readiness-controller-context";
import {
  BootstrapLogDisclosure,
  LocalHostBodyShell,
  LocalHostLoadingContent,
} from "@/components/local-host-loading";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import { TooltipProvider } from "@/components/ui/tooltip";
import { buildHostProgressView } from "@/lib/host/host-progress-copy";
import { cn } from "@/lib/utils";
import { useDesktopDialogStore } from "@/stores/dialogs/desktop-dialog-store";
import "@/index.css";

/**
 * THE BOOT-FAMILY GALLERY: every face a launch can show, one per page load,
 * selected by `?face=<name>` (and `?theme=dark` for the dark variant).
 *
 * WHY IT EXISTS. This family has been "unified" three times, and each time the
 * report was visual - "it looks very weird, non aligned", "a modal with only
 * the Open settings button". jsdom cannot see any of that: it has no layout
 * engine, so a card that is 64px wider than its neighbour, or 20px lower, or
 * empty but for one link, is invisible to every unit test in the tree. The
 * only instrument that sees the defect is a rendered screenshot, and this
 * fixture is what `scripts/host-boot-family-gallery-browser.mjs` renders to
 * take them - and to read the card's box on each face, so "one geometry" is a
 * measured claim rather than a described one.
 *
 * NOT wired into CI. It is a manual instrument for the person changing this
 * family: run the driver, look at the images, read the table. Wiring an
 * unrun screenshot lane into CI is a new gate with a false-pass default and
 * nobody watching it.
 *
 * WHAT IS REAL AND WHAT IS A STAND-IN, stated because a gallery that measures
 * its own scaffolding proves nothing:
 *  - Every CARD is the production component with production props:
 *    `HostRuntimeBootFallback`, `HostBootSurface`, `WindowHostStartupCard`,
 *    `SurfaceReadinessFallback`, `WindowHostModal`, and the bodies
 *    `buildBootBody` composes for the narrator (`LocalHostLoadingContent`,
 *    `LocalBootstrapAttempts` + `BootstrapLogDisclosure`).
 *  - The header BAND is a stand-in (`FrameHeaderBand`). The real `AppHeader`
 *    needs the app's provider stack; the band only has to occupy the header's
 *    exact height (`APP_HEADER_HEIGHT_CLASS`) so the box under it is the box
 *    the real frame has. The gate frame's column and `p-6` slot are copied
 *    from `DefaultHostReadyGate` / `AttachPendingCard` for the same reason.
 *
 * The `dialog` face is the gallery's own CONTROL: it is the one member drawn
 * at a different width on purpose (a dialog over a live app), so a report in
 * which every face measures the same width - dialog included - is a report
 * from an instrument that cannot see width.
 */
const FACES = [
  "runtime",
  "attach",
  "restoring",
  "narrator-idle",
  "narrator-lane",
  "narrator-slow",
  "narrator-failed",
  "narrator-no-host",
  "narrator-plan",
  "narrator-update",
  "gate-provisioning-error",
  "gate-removed",
  "dialog",
] as const;
export type GalleryFace = (typeof FACES)[number];

const params = new URLSearchParams(location.search);
const requestedFace = params.get("face");
const face: GalleryFace = FACES.includes(requestedFace as GalleryFace)
  ? (requestedFace as GalleryFace)
  : "narrator-idle";
if (params.get("theme") === "dark") {
  document.documentElement.classList.add("dark");
}
// The narrator's failed faces and the gate's provisioning-error card offer
// `Report issue`, which gates on this store. Production sets it from the
// desktop shell; here it is set so the row renders the way a user sees it.
useDesktopDialogStore.getState().setReportIssueAvailable(true);

const BOOTSTRAP_TAIL = [
  "[host] resolving release channel stable",
  "[host] downloading traycer-host 1.2.3",
  "[host] verifying signature",
].join("\n");

function buildRunnerHost(): MockRunnerHost {
  const traycerCli = new MockTraycerCli();
  traycerCli.hostStatusSnapshot = {
    running: false,
    pidMetadata: null,
    bootstrapMarkers: [
      {
        timestamp: "2026-01-01T00:00:00.000Z",
        phase: "starting",
        fields: { shell: "/bin/zsh", args: "-i -l -c traycer" },
      },
      {
        timestamp: "2026-01-01T00:00:03.000Z",
        phase: "crashed",
        fields: { code: "1" },
      },
    ],
    bootstrapLogPath: "/Users/me/.traycer/bootstrap.log",
    bootstrapLogTail: BOOTSTRAP_TAIL,
  };
  return new MockRunnerHost({
    signInUrl: "https://auth.traycer.invalid/sign-in",
    authnBaseUrl: "http://localhost:5005",
    localHost: null,
    hosts: [],
    workspaceFolderPickerPaths: undefined,
    hasLocalHost: undefined,
    traycerCli,
  });
}

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
});

const noop = (): void => undefined;

const LANE_PROGRESS = buildHostProgressView({
  kind: "ensure",
  startedAt: "2026-01-01T00:00:00.000Z",
  progress: {
    stage: "download",
    percent: 42,
    bytes: 104_857_600,
    totalBytes: 250_609_664,
    workUnits: null,
    message: "downloading host 1.2.3",
  },
});

const PRESENTATION: DefaultHostReadinessPresentation = {
  targetKind: "local",
  localBootIntent: true,
  localHostState: "unavailable",
  stage: "loading",
  progress: null,
  lastProgress: null,
  provisioningError: null,
  provisioning: false,
  removed: false,
  hostBusy: false,
  canManageHost: true,
  retryProvisioning: noop,
  forceProvisioning: noop,
  reinstall: noop,
  configureShell: noop,
  refreshDirectory: noop,
  openSettings: noop,
  compatibility: {
    status: "compatible",
    degraded: false,
    unreachable: false,
    hostStatus: null,
  },
};

/** The stand-in for `AppHeader variant="host-loading"`: its height and nothing else. */
function FrameHeaderBand(): ReactElement {
  return (
    <div
      data-gallery-header-band
      className={cn(
        "relative z-20 flex shrink-0 items-center border-b border-border/90 bg-canvas px-3 text-ui-xs text-muted-foreground",
        APP_HEADER_HEIGHT_CLASS,
      )}
    >
      Traycer
    </div>
  );
}

/** The gate frame (`DefaultHostReadyGate`): header band over a `min-h-svh` column. */
function GateFrame(props: { readonly children: ReactNode }): ReactElement {
  return (
    <div className="flex min-h-svh w-full flex-col bg-background text-foreground">
      <FrameHeaderBand />
      {props.children}
    </div>
  );
}

/** The failed-attempt body, exactly as `buildBootBody`'s settled arm composes it. */
function settledBody(): ReactNode {
  return (
    <LocalHostBodyShell>
      <LocalBootstrapAttempts />
      <BootstrapLogDisclosure onConfigureShell={noop} trailing={null} />
    </LocalHostBodyShell>
  );
}

/** The healthy body, exactly as `buildBootBody`'s loading arm composes it. */
function loadingBody(
  progress: WindowHostModalProps["progress"],
  settingsOnly: boolean,
): ReactNode {
  return (
    <LocalHostLoadingContent
      progress={progress}
      onConfigureShell={noop}
      footerTrailing={
        settingsOnly ? <BootOpenSettingsButton onOpenSettings={noop} /> : null
      }
    />
  );
}

const HEALTHY: WindowHostModalProps = {
  cause: "cold-start",
  variant: { kind: "offline" },
  progress: null,
  bootBody: loadingBody(null, true),
  onRetry: null,
  retryPending: false,
  onUpdateHost: null,
  onOpenSettings: noop,
  showReportIssue: false,
  settingsEmphasis: "link",
  settingsOnly: true,
};

function narratorProps(which: GalleryFace): WindowHostModalProps {
  switch (which) {
    case "narrator-lane":
      return {
        ...HEALTHY,
        progress: LANE_PROGRESS,
        bootBody: loadingBody(LANE_PROGRESS, true),
      };
    case "narrator-slow":
      return {
        ...HEALTHY,
        progress: LANE_PROGRESS,
        bootBody: loadingBody(LANE_PROGRESS, false),
        onRetry: noop,
        settingsEmphasis: "button",
        settingsOnly: false,
      };
    case "narrator-failed":
      return {
        ...HEALTHY,
        bootBody: settledBody(),
        onRetry: noop,
        showReportIssue: true,
        settingsEmphasis: "button",
        settingsOnly: false,
      };
    case "narrator-no-host":
    case "dialog":
      return {
        ...HEALTHY,
        cause: "no-usable-host",
        bootBody: settledBody(),
        onRetry: noop,
        showReportIssue: true,
        settingsEmphasis: "button",
        settingsOnly: false,
      };
    case "narrator-plan":
      return {
        ...HEALTHY,
        cause: "no-usable-host",
        variant: { kind: "plan-restricted" },
        bootBody: null,
        showReportIssue: true,
        settingsEmphasis: "button",
        settingsOnly: false,
      };
    case "narrator-update":
      return {
        ...HEALTHY,
        cause: "no-usable-host",
        variant: {
          kind: "update-host",
          hostId: "local-host",
          isTargetHost: true,
          detail: {
            code: "HOST_PROTOCOL_TOO_OLD",
            hostVersion: "1.1.4",
            minSupportedVersion: "1.2.0",
          },
        },
        bootBody: null,
        onUpdateHost: noop,
        showReportIssue: true,
        settingsEmphasis: "button",
        settingsOnly: false,
      };
    default:
      return HEALTHY;
  }
}

function gateReadiness(which: GalleryFace): GateDrawnReadiness {
  if (which === "gate-removed") return { kind: "removed-host" };
  if (which === "restoring") return { kind: "restoring-request-context" };
  return { kind: "provisioning-error" };
}

function gatePresentation(
  which: GalleryFace,
): DefaultHostReadinessPresentation {
  if (which === "gate-provisioning-error") {
    return {
      ...PRESENTATION,
      provisioningError: new Error(
        "traycer host ensure exited with code 1 (see bootstrap.log)",
      ),
    };
  }
  if (which === "gate-removed") return { ...PRESENTATION, removed: true };
  return PRESENTATION;
}

function Face(): ReactElement {
  switch (face) {
    case "runtime":
      return (
        <HostRuntimeBootFallback
          onConfigureShell={noop}
          onOpenSettings={noop}
        />
      );
    case "attach":
      return (
        <GateFrame>
          {/* `AttachPendingCard`'s slot, verbatim. */}
          <div className="flex flex-1 items-center justify-center p-6">
            <HostBootSurface
              testId="host-gate-attach-pending"
              onConfigureShell={noop}
              onOpenSettings={noop}
            />
          </div>
        </GateFrame>
      );
    case "restoring":
    case "gate-provisioning-error":
    case "gate-removed":
      return (
        <HostReadinessControllerContext.Provider
          value={{
            readinessFor: () => gateReadiness(face),
            defaultHostPresentation: gatePresentation(face),
            hasBeenDefaultHostReady: false,
          }}
        >
          <GateFrame>
            <SurfaceReadinessFallback readiness={gateReadiness(face)} />
          </GateFrame>
        </HostReadinessControllerContext.Provider>
      );
    case "dialog":
      return (
        <>
          <div className="flex min-h-svh w-full flex-col bg-background text-foreground">
            <FrameHeaderBand />
            <div className="flex-1 p-6 text-ui-sm text-muted-foreground">
              (a mounted app sits behind the dialog)
            </div>
          </div>
          <WindowHostModal {...narratorProps(face)} />
        </>
      );
    default:
      // The narrator's startup card floats in a fixed layer over the gate
      // frame, whose own attach cover has yielded (`attached === true`).
      return (
        <>
          <GateFrame>
            <div className="flex flex-1 items-center justify-center p-6" />
          </GateFrame>
          <WindowHostStartupCard {...narratorProps(face)} />
        </>
      );
  }
}

export function HostBootFamilyGalleryFixture(): ReactElement {
  return (
    <QueryClientProvider client={queryClient}>
      <RunnerHostProvider runnerHost={buildRunnerHost()}>
        <TooltipProvider>
          <div data-gallery-face={face}>
            <Face />
          </div>
        </TooltipProvider>
      </RunnerHostProvider>
    </QueryClientProvider>
  );
}

const container = document.querySelector("#root");
if (container === null) throw new Error("gallery root missing");
createRoot(container).render(<HostBootFamilyGalleryFixture />);
