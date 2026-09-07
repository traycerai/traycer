import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";

import { TabHostProvider } from "@/components/epic-canvas/tab-host-provider";
import { ACTIVE_TILE_PLACEMENT } from "@/lib/canvas/conversation-tile-placement";
import { EpicSessionContext } from "@/lib/registries/epic-session-registry";
import {
  createOpenEpicStore,
  type EpicStreamClientFactory,
  type OpenEpicStoreHandle,
} from "@/stores/epics/open-epic/store";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { useNewConversationModalOpenStore } from "@/stores/epics/new-conversation-modal-open-store";
import { useNewConversationModalStore } from "@/stores/epics/new-conversation-modal-store";

import { useArtifactQuoteActions } from "../use-artifact-quote-actions";
import type { ArtifactQuoteSnapshot } from "../artifact-quote-snapshot";

const EPIC_ID = "epic-1";
const TAB_ID = "tab-1";
const TAB_HOST_ID = "tab-host";

const noopStreamClientFactory: EpicStreamClientFactory = () => ({
  applyUpdate: () => undefined,
  awareness: () => undefined,
  applyArtifactRoomUpdate: () => undefined,
  artifactRoomAwareness: () => undefined,
  retryMigration: () => undefined,
  close: () => undefined,
});

const SNAPSHOT: ArtifactQuoteSnapshot = {
  from: 1,
  to: 10,
  blocks: [
    { type: "paragraph", content: [{ type: "text", text: "Step one" }] },
  ],
};

let epicHandle: OpenEpicStoreHandle | null = null;

function wrapperFor(handle: OpenEpicStoreHandle) {
  return function Wrapper({ children }: { readonly children: ReactNode }) {
    return (
      <EpicSessionContext.Provider value={handle}>
        <TabHostProvider hostId={TAB_HOST_ID}>{children}</TabHostProvider>
      </EpicSessionContext.Provider>
    );
  };
}

function renderActions() {
  const handle = createOpenEpicStore({
    epicId: EPIC_ID,
    streamClientFactory: noopStreamClientFactory,
    userId: null,
    onAuthError: null,
  });
  epicHandle = handle;
  return renderHook(
    () =>
      useArtifactQuoteActions({
        epicId: EPIC_ID,
        viewTabId: TAB_ID,
        artifactId: "artifact-1",
        artifactKind: "spec",
      }),
    { wrapper: wrapperFor(handle) },
  );
}

describe("useArtifactQuoteActions", () => {
  afterEach(() => {
    cleanup();
    epicHandle?.dispose();
    epicHandle = null;
    useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
    useNewConversationModalOpenStore.getState().close();
    useNewConversationModalStore.getState().resetForTests();
  });

  /**
   * An artifact is projected onto every host serving the epic, unlike a
   * terminal which is local to the tile's host - so the new-conversation
   * modal opens with no named host at all, letting it fall back to the
   * epic's own placement rather than a machine the quote has no reason to
   * care about.
   */
  it("opens the new-conversation modal with hostId null, draft written first", () => {
    const { result } = renderActions();

    act(() => {
      result.current.quoteToNewChat(SNAPSHOT);
    });

    expect(useNewConversationModalOpenStore.getState().request).toEqual({
      epicId: EPIC_ID,
      tabId: TAB_ID,
      placement: ACTIVE_TILE_PLACEMENT,
      parentId: null,
      hostId: null,
    });
    // The draft is written BEFORE the open request, because the modal body
    // seeds its composer from this store as it mounts.
    const draft =
      useNewConversationModalStore.getState().draftPatchesByEpicId[EPIC_ID];
    expect(JSON.stringify(draft?.content)).toContain("Step one");
    expect(JSON.stringify(draft?.content)).toContain("sourcedQuote");
    expect(draft?.selection).toBeNull();
  });
});
