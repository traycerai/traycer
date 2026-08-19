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

/**
 * Browser fixture for the local-bootstrap body's ALIGNMENT inside the real
 * window host modal.
 *
 * It exists because the claim is geometric - "the card reads as three
 * alignments" - and jsdom has no layout engine, so no jsdom assertion can tell
 * a left-aligned control from a centred one. `self-center` is a flex property
 * whose whole effect is a resolved box position; in jsdom it is a string on a
 * `class` attribute and nothing more. A jsdom test could only assert that the
 * class is absent, which pins the CURRENT SPELLING of the fix rather than the
 * property it was meant to buy - and would pass just as happily on a build that
 * re-centred the control by any other means.
 *
 * IMPORT DISCIPLINE, load-bearing: this fixture imports only symbols that exist
 * both before and after the fix, so the same file can be measured against the
 * unfixed tree without editing it. Importing the shell component the fix
 * introduces would make the negative control fail to BUILD, and "the control
 * did not run" is indistinguishable in a log from "the control found nothing".
 *
 * Scope: the cold-start (loading) arm. The other local arm's panel/disclosure
 * ORDER is a document-order claim, which jsdom can see, so it is pinned there
 * instead - the instrument follows the claim.
 */
const BOOTSTRAP_TAIL = [
  "[host] resolving release channel stable",
  "[host] downloading traycer-host 1.2.3",
  "[host] verifying signature",
].join("\n");

/**
 * Which of the disclosure's two tail states to render, from `?tail=empty`.
 *
 * Both are measured, in separate page loads, because they are the SAME slot in
 * two states and only one of them was ever looked at. The empty one is not a
 * rare branch: on the arm where nothing can serve the window the host never
 * reported ready, so an empty `bootstrap.log` tail is the expected reading.
 */
const wantsEmptyTail =
  new URLSearchParams(location.search).get("tail") === "empty";

/**
 * `?progress=none` renders the card as it looks the instant a stage TRANSITIONS.
 *
 * Since the progress carry-forward was scoped to one stage, `percent` blanks at
 * download -> extract instead of inheriting 100, so the whole download-progress
 * block unmounts. This load is what measures whether the card jumps when it goes.
 */
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
 * The comparator's own positive control, and the reason it is in the DOM rather
 * than in the driver's prose.
 *
 * Every assertion below is of the form "these two left edges agree". An
 * instrument that reports agreement because it is reading two nulls, or two
 * copies of the same node, or rects it never actually resolved, reports a PASS -
 * the default failure mode of a verification instrument is a false pass. This
 * column reproduces the defect deliberately: a left-aligned line and a
 * `self-center` control in the same flex column. The driver requires it to be
 * flagged as MISALIGNED in the same run, which is what separates "the edges
 * agree" from "the comparator cannot tell".
 *
 * Laid out behind the modal overlay. Rects come from layout, not from
 * visibility, so being covered costs the measurement nothing.
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
      {/* The SECOND defect form, and the reason it needs its own control.
          In a column whose items stretch, a control that centres only its
          CONTENT keeps a full-width box - so its box's left edge still sits on
          the card's edge while the label a user reads sits in the middle. A
          comparator that measures boxes reports that as aligned. This one is
          flagged only by measuring the label, which is what the driver does. */}
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

/**
 * Module scope, not per render: a client constructed in the component body is a
 * new client on every render, which throws away the cache the disclosure's
 * status query depends on.
 */
const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
});

export function WindowHostModalAlignmentFixture(): React.ReactElement {
  // Built through the real shared copy table rather than hand-assembled, so the
  // body renders the same heading and progress bar a live download does - they
  // are members of the alignment set being measured. (The table's detail line
  // and byte count are supplied and deliberately NOT drawn by this body; see
  // `HostProgress`.)
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
