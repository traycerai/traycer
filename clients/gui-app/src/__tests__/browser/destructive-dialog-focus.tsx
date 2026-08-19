import { createRoot } from "react-dom/client";
import { UnsyncedCloseDialog } from "@/components/layout/dialogs/unsynced-close-dialog";
import { __getOpenEpicRegistryForTests } from "@/lib/registries/epic-session-registry";
import {
  createOpenEpicStore,
  type EpicStreamClientFactory,
} from "@/stores/epics/open-epic/store";
import "@/index.css";

/**
 * Which control does a destructive confirmation open FOCUSED on?
 *
 * Driven in a real browser because that is where a focus scope resolves "the
 * first tabbable descendant" for real. The quit intercept was measured to open
 * on its destructive control; this asks the same question of the tab-close
 * confirmation, which fires far more often, rather than inferring it from the
 * shared composition.
 *
 * The dialog dismisses itself the moment its epic reads clean, so the registry
 * is seeded with a dirty session first - without that the fixture would measure
 * a dialog that had already closed.
 */
const EPIC_ID = "epic-close-focus";

const noopStreamClientFactory: EpicStreamClientFactory = () => ({
  applyUpdate: () => undefined,
  awareness: () => undefined,
  applyArtifactRoomUpdate: () => undefined,
  artifactRoomAwareness: () => undefined,
  retryMigration: () => undefined,
  close: () => undefined,
});

function seedDirtyEpic(): void {
  const registry = __getOpenEpicRegistryForTests();
  const handle = createOpenEpicStore({
    epicId: EPIC_ID,
    streamClientFactory: noopStreamClientFactory,
    userId: null,
    onAuthError: null,
  });
  handle.doc.getMap("epic").set("title", "Rewrite the onboarding");
  handle.store.setState({ isDirty: true, unsyncedQueueSize: 2 });
  registry.acquireMounted(EPIC_ID, () => handle);
}

export function DestructiveDialogFocusFixture(): React.ReactElement {
  return (
    <div>
      <div id="probe-state" />
      <UnsyncedCloseDialog
        open
        epicId={EPIC_ID}
        onWait={() => undefined}
        onDiscard={() => undefined}
      />
    </div>
  );
}

seedDirtyEpic();
const container = document.querySelector("#root");
if (container === null) throw new Error("probe root missing");
createRoot(container).render(<DestructiveDialogFocusFixture />);
