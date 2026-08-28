import { useState } from "react";
import { createRoot } from "react-dom/client";
import { QuitInterceptBridge } from "@/components/layout/bridges/quit-intercept-bridge";
import { __getOpenEpicRegistryForTests } from "@/lib/registries/epic-session-registry";
import {
  createOpenEpicStore,
  type EpicStreamClientFactory,
} from "@/stores/epics/open-epic/store";
import "@/index.css";

/**
 * Browser fixture for the quit intercept's Cancel path.
 *
 * It exists because the claim under test is **"the modal is gone and the window
 * is interactive again"**, and jsdom cannot see the second half: it performs no
 * hit testing, so `fireEvent.click` reaches a node whether or not a real user
 * could. A jsdom test can assert that Radix released its
 * `body { pointer-events: none }` lock, which is a PROXY for interactivity, not
 * the thing itself. Here the same question is answered by clicking a button
 * behind the modal in a real layout engine and counting whether the click
 * arrived.
 *
 * The measured premise comes first: while the dialog is open, that same click at
 * that same pixel must NOT arrive. Otherwise "the click worked after Cancel"
 * would be satisfied by a modal that never blocked anything, and the fixture
 * would pass on a build where Cancel does nothing at all.
 *
 * The row under test is a buffer RETAINED across a host re-point, not merely a
 * dirty live session: a dirty session drains on its own and the modal closes
 * from the auto-proceed gate, so only a retention reproduces the state where
 * waiting can never end and Cancel is the only non-destructive exit.
 */
const EPIC_ID = "epic-quit-cancel";
const QUIT_REQUEST_ID = "quit-probe-1";

const noopStreamClientFactory: EpicStreamClientFactory = () => ({
  applyUpdate: () => undefined,
  awareness: () => undefined,
  applyArtifactRoomUpdate: () => undefined,
  artifactRoomAwareness: () => undefined,
  retryMigration: () => undefined,
  close: () => undefined,
});

interface QuitRequestPayload {
  readonly requestId: string;
  readonly snapshot: ReadonlyArray<{
    readonly epicId: string;
    readonly title: string;
    readonly queueSize: number;
    readonly isDirty: boolean;
  }>;
}

interface DecisionResponse {
  readonly requestId: string;
  readonly decision: string;
}

type DecisionPayload = string | DecisionResponse;

/**
 * The seams the CDP driver reaches through. Widened with an intersection rather
 * than a `declare global`, mirroring how this repo's own quit-intercept test
 * widens `window` for `runnerHost`, so the extra members stay local to the
 * fixture instead of leaking into every file's `Window`.
 */
interface ProbeWindowGlobals {
  runnerHost?: unknown;
  __probeEmitQuit?: () => void;
  __probeRetainedRows?: () => number;
}

function seedRetainedBuffer(): void {
  const registry = __getOpenEpicRegistryForTests();
  const outgoing = createOpenEpicStore({
    epicId: EPIC_ID,
    streamClientFactory: noopStreamClientFactory,
    userId: null,
    onAuthError: null,
  });
  outgoing.doc.getMap("epic").set("title", "Rewrite the onboarding");
  outgoing.store.setState({ isDirty: true, unsyncedQueueSize: 3 });
  registry.acquireMounted(EPIC_ID, () => outgoing);
  const incoming = createOpenEpicStore({
    epicId: EPIC_ID,
    streamClientFactory: noopStreamClientFactory,
    userId: null,
    onAuthError: null,
  });
  // The re-point. The outgoing handle is dirty, so the registry retains it with
  // its transport detached - which is what makes its row un-syncable for ever.
  registry.replaceMounted(EPIC_ID, outgoing, incoming, {
    hostStamp: "host-a",
    ownerIdentityKey: "key-a",
    editsTransferredToReplacement: false,
  });
}

function installAppLifecycle(): void {
  let quitHandler: ((request: unknown) => void) | null = null;
  // Resolved per call, NOT captured once: `installAppLifecycle` runs before
  // React has committed, so a captured reference would be null and every
  // `record` would silently no-op through `?.` - a recorder that records
  // nothing, which reads in the driver exactly like the renderer failing to
  // respond.
  const record = (name: string, value: string): void => {
    const state = document.querySelector("#probe-state");
    if (state === null) throw new Error("#probe-state missing");
    state.setAttribute(name, value);
  };
  const probeWindow = window as Window & ProbeWindowGlobals;
  probeWindow.runnerHost = {
    appLifecycle: {
      setUnsyncedEditsSnapshot: () => Promise.resolve(),
      acknowledgeQuitRequest: (requestId: string) => {
        record("data-acked", requestId);
        return Promise.resolve();
      },
      respondToQuitRequest: (payload: DecisionPayload) => {
        record(
          "data-decision",
          typeof payload === "string" ? payload : payload.decision,
        );
        return Promise.resolve();
      },
      onQuitRequested: (handler: (request: unknown) => void) => {
        quitHandler = handler;
        return {
          dispose: () => {
            quitHandler = null;
          },
        };
      },
      onGetFreshUnsyncedSnapshot: () => ({ dispose: () => undefined }),
      respondFreshUnsyncedSnapshot: () => Promise.resolve(),
    },
  };
  probeWindow.__probeEmitQuit = () => {
    if (quitHandler === null) throw new Error("no quit-request subscriber");
    const request: QuitRequestPayload = {
      requestId: QUIT_REQUEST_ID,
      snapshot: [
        {
          epicId: EPIC_ID,
          title: "Rewrite the onboarding",
          queueSize: 3,
          isDirty: true,
        },
      ],
    };
    quitHandler(request);
  };
  probeWindow.__probeRetainedRows = () =>
    __getOpenEpicRegistryForTests().getUnsyncedEdits().length;
}

export function QuitInterceptCancelFixture(): React.ReactElement {
  const [appClicks, setAppClicks] = useState(0);
  return (
    <div>
      <div id="probe-state" data-app-clicks={String(appClicks)} />
      <button
        id="app-button"
        type="button"
        onClick={() => {
          setAppClicks((count) => count + 1);
        }}
      >
        A button in the app behind the modal
      </button>
      <QuitInterceptBridge />
    </div>
  );
}

seedRetainedBuffer();
const container = document.querySelector("#root");
if (container === null) throw new Error("probe root missing");
createRoot(container).render(<QuitInterceptCancelFixture />);
installAppLifecycle();
