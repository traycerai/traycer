/**
 * A task this window holds a session for, built the way
 * `side-tab-hover-card.test.tsx` builds one: a real open-epic store registered
 * in the real registry, its chats as the projection the strip names agents from.
 */
import { act } from "@testing-library/react";
import { __getOpenEpicRegistryForTests } from "@/lib/registries/epic-session-registry";
import type { EpicStreamClientFactory } from "@/stores/epics/open-epic/store";
import {
  openStoreForTest,
  type OpenedStoreForTest,
} from "@/stores/epics/open-epic/test-support/open-store-for-test";
import type { ChatProjection } from "@/stores/epics/open-epic/types";

const fakeStreamClientFactory: EpicStreamClientFactory = () => ({
  applyUpdate: () => undefined,
  awareness: () => undefined,
  applyArtifactRoomUpdate: () => undefined,
  artifactRoomAwareness: () => undefined,
  retryMigration: () => undefined,
  close: () => undefined,
});

export function chatProjection(
  id: string,
  overrides: Partial<ChatProjection>,
): ChatProjection {
  return {
    id,
    title: "Chat",
    parentId: null,
    createdAt: 0,
    updatedAt: 0,
    userId: null,
    hostId: "host-a",
    isTitleEditedByUser: false,
    docResident: false,
    archivedAt: null,
    settings: null,
    ...overrides,
  };
}

const handles: OpenedStoreForTest[] = [];

/** Registers a session for `epicId` holding `chats`. */
export function warmEpic(
  epicId: string,
  chats: ReadonlyArray<ChatProjection>,
): void {
  const handle = openStoreForTest({
    epicId,
    userId: null,
    factories: {
      streamClientFactory: fakeStreamClientFactory,
      laneSelection: null,
    },
    writeCommand: null,
  });
  handles.push(handle);
  handle.store.setState({
    chats: {
      allIds: chats.map((chat) => chat.id),
      byId: Object.fromEntries(chats.map((chat) => [chat.id, chat])),
    },
  });
  act(() => {
    __getOpenEpicRegistryForTests().acquire(epicId, () => handle);
  });
}

/** Drops every session `warmEpic` registered. */
export function coolAllEpics(): void {
  __getOpenEpicRegistryForTests().disposeAll();
  for (const handle of handles) handle.dispose();
  handles.length = 0;
}
