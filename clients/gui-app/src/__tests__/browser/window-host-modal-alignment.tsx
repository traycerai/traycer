import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  MockRunnerHost,
  MockTraycerCli,
} from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import { WindowHostModal } from "@/components/layout/dialogs/window-host-modal";
import { LocalHostLoadingContent } from "@/components/local-host-loading";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import { TooltipProvider } from "@/components/ui/tooltip";
import { buildHostProgressView } from "@/lib/host/host-progress-copy";
import "@/index.css";

/** Local-bootstrap alignment inside the real window host modal. jsdom has no layout, so this is a real-browser fixture. Import only symbols that exist before and after the fix so the negative control can still build. */
const BOOTSTRAP_TAIL = [
  "[host] resolving release channel stable",
  "[host] downloading traycer-host 1.2.3",
  "[host] verifying signature",
].join("\n");

/** ?tail=empty is the expected bootstrap.log when the host never reported ready. Measure both tail states in separate loads. */
const wantsEmptyTail =
  new URLSearchParams(location.search).get("tail") === "empty";

/** ?progress=none is the stage-transition frame: percent blanks so the progress block unmounts. Measure whether the card jumps. */
const wantsNoProgressNumbers =
  new URLSearchParams(location.search).get("progress") === "none";

function buildRunnerHost(): MockRunnerHost {
  const traycerCli = new MockTraycerCli();
  traycerCli.hostStatusSnapshot = {
    running: false,
    pidMetadata: null,
    bootstrapMarkers: [],
    bootstrapLogPath: "/mock/bootstrap.log",
    bootstrapLogTail: wantsEmptyTail ? "" : BOOTSTRAP_TAIL,
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

/**
 * Positive control: a left-aligned line and a `self-center` control must be flagged as misaligned in the same run, or the comparator cannot tell.
 */
function PlantedMisalignment(): React.ReactElement {
  return (
    <div
      data-probe-planted-column
      className="flex w-[32rem] flex-col gap-4 p-6 text-left"
    >
      <p data-probe-planted-heading className="text-ui font-medium">
        A heading that sits on the column's left edge
      </p>
      <button
        type="button"
        data-probe-planted-control
        className="inline-flex items-center gap-1 self-center text-ui-xs"
      >
        A control that centres itself
      </button>
      {/* Stretch column: a full-width box can still centre its label. Measure
          the label, not the box. */}
      <button
        type="button"
        data-probe-planted-inner-centre
        className="inline-flex w-full items-center justify-center gap-1 text-ui-xs"
      >
        <span data-probe-planted-inner-label>
          A full-width control whose label centres
        </span>
      </button>
    </div>
  );
}

/** Module-scope client. A per-render client throws away the disclosure query cache. */
const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
});

export function WindowHostModalAlignmentFixture(): React.ReactElement {
  // Real copy table so heading and progress bar match a live download.
  // Detail line and byte count are supplied but not drawn.
  const progress = buildHostProgressView({
    kind: "ensure",
    startedAt: "2026-01-01T00:00:00.000Z",
    progress: wantsNoProgressNumbers
      ? {
          // The extract announce, post-scoping: a stage with no measured
          // position yet.
          stage: "extract",
          percent: null,
          bytes: null,
          totalBytes: null,
          workUnits: null,
          message: "extracting host archive",
        }
      : {
          stage: "download",
          percent: 42,
          bytes: 104_857_600,
          totalBytes: 250_609_664,
          workUnits: null,
          message: "downloading host 1.2.3",
        },
  });
  return (
    <QueryClientProvider client={queryClient}>
      <RunnerHostProvider runnerHost={buildRunnerHost()}>
        <TooltipProvider>
          <PlantedMisalignment />
          <WindowHostModal
            cause="cold-start"
            variant={{ kind: "offline" }}
            progress={progress}
            // The REAL body, composed exactly as `buildBootBody` composes it
            // for this arm. A hand-rolled stand-in would be a
            // measurement of the fixture.
            bootBody={
              <LocalHostLoadingContent
                progress={progress}
                onConfigureShell={() => undefined}
                footerTrailing={null}
              />
            }
            onRetry={null}
            retryPending={false}
            onUpdateHost={null}
            onOpenSettings={() => undefined}
            showReportIssue={false}
            settingsEmphasis="link"
            settingsOnly={false}
          />
        </TooltipProvider>
      </RunnerHostProvider>
    </QueryClientProvider>
  );
}

const container = document.querySelector("#root");
if (container === null) throw new Error("probe root missing");
createRoot(container).render(<WindowHostModalAlignmentFixture />);
