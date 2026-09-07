import { createRoot } from "react-dom/client";
import { UnsyncedCloseDialog } from "@/components/layout/dialogs/unsynced-close-dialog";
import { __getOpenEpicRegistryForTests } from "@/lib/registries/epic-session-registry";
import { type EpicStreamClientFactory } from "@/stores/epics/open-epic/store";
import { openStoreForTest } from "@/stores/epics/open-epic/test-support/open-store-for-test";
import "@/index.css";

/**
 * Which control does a destructive confirmation open focused on? Seed a dirty session first or the dialog dismisses itself.
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
  const handle = openStoreForTest({
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
