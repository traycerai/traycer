import { useState } from "react";
import { createRoot } from "react-dom/client";
import { QuitInterceptBridge } from "@/components/layout/bridges/quit-intercept-bridge";
import { __getOpenEpicRegistryForTests } from "@/lib/registries/epic-session-registry";
import { type EpicStreamClientFactory } from "@/stores/epics/open-epic/store";
import { openStoreForTest } from "@/stores/epics/open-epic/test-support/open-store-for-test";
import "@/index.css";

/** Quit-intercept Cancel: after Cancel, a real click behind the modal must arrive. While open, that same pixel must not. Use a buffer retained across a host re-point; a dirty live session auto-proceeds and never needs Cancel. */
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

/** Intersection widen, not declare global, so extra window members stay local to this fixture. */
interface ProbeWindowGlobals {
  runnerHost?: unknown;
  __probeEmitQuit?: () => void;
  __probeRetainedRows?: () => number;
}

function seedRetainedBuffer(): void {
  const registry = __getOpenEpicRegistryForTests();
  const outgoing = openStoreForTest({
    epicId: EPIC_ID,
    userId: null,
    // Factories go to the composition; createOpenEpicStore no longer builds a
    // runtime. handle.doc still resolves because this harness builds it here.
    factories: {
      streamClientFactory: noopStreamClientFactory,
      laneSelection: null,
    },
    // Explicit: `null` means this suite never writes, so a write in
    // one that said so fails rather than resolving quietly.
    writeCommand: null,
  });
  outgoing.doc.getMap("epic").set("title", "Rewrite the onboarding");
  outgoing.store.setState({ isDirty: true, unsyncedQueueSize: 3 });
  registry.acquireMounted(EPIC_ID, () => outgoing);
  const incoming = openStoreForTest({
    epicId: EPIC_ID,
    userId: null,
    // Factories go to the composition; createOpenEpicStore no longer builds a
    // runtime. handle.doc still resolves because this harness builds it here.
    factories: {
      streamClientFactory: noopStreamClientFactory,
      laneSelection: null,
    },
    // Explicit: `null` means this suite never writes, so a write in
    // one that said so fails rather than resolving quietly.
    writeCommand: null,
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
  // Resolve per call. installAppLifecycle runs before commit; a captured
  // reference would be null and record would silently no-op.
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
