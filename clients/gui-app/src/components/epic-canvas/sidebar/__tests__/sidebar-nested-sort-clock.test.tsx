import "../../../../../__tests__/test-browser-apis";
import { cleanup, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import type { EpicStreamCallbacks } from "@traycer-clients/shared/host-transport/epic-stream-client";
import type {
  ChatRecordHeadStamp,
  ChatRecordSummaryV12,
} from "@traycer/protocol/host/epic/chat-records";
import type { SnapshotMetaEpic } from "@traycer/protocol/host/epic/snapshot-meta";
import {
  CHATS_TREE_FILTER,
  collectVisibleSidebarTreeIds,
} from "@/components/epic-canvas/sidebar/epic-sidebar-selection";
import {
  SidebarSortClockContext,
  SidebarSortContext,
  useFilteredPanelChildIds,
} from "@/components/epic-canvas/sidebar/epic-sidebar-filter";
import {
  makeNodeComparator,
  SORT_DIRECTION,
  SORT_FIELD,
  type NodeComparator,
  type NodeSortClock,
} from "@/lib/epic-sort";
import { localChatLastActiveAtById } from "@/lib/chats/unified-chat-list";
import { EpicSessionContext } from "@/lib/registries/epic-session-registry";
import {
  type EpicStreamClientFactory,
  type OpenEpicStoreHandle,
} from "@/stores/epics/open-epic/store";
import { openStoreForTest } from "@/stores/epics/open-epic/test-support/open-store-for-test";

/**
 * A NESTED foreign child reorders on a head-only delta, exactly as a root
 * does.
 *
 * `localChatLastActiveAtById` (chats/unified-chat-list.ts) builds one clock
 * covering every chat in the projection, roots and nested children alike, and
 * `sortNodeIdsWithClock` (epic-sort.ts) is applied at EVERY level a tree walk
 * visits - so a foreign child's publication clock has to move it under its
 * parent the same way a foreign root's clock moves it among its siblings.
 * This file pins that at both the pure-selector level
 * (`collectVisibleSidebarTreeIds`) and the hook level
 * (`useFilteredPanelChildIds` + `SidebarSortClockContext`), since the two are
 * meant to agree - the flat-list selector and the rendered panel walk the
 * same clock through the same comparator.
 */

const EPIC_ID = "epic-nested-sort-clock";
const SESSION_HOST_ID = "host-a";
const FOREIGN_HOST_ID = "host-b";
const OWNER_USER_ID = "user-a";
const PARENT_ID = "chat-parent";
const OLD_ID = "chat-old";
const NEW_ID = "chat-new";
const OLD_UPDATED_AT = 100;
const NEW_UPDATED_AT = 200;
const HEAD_PUBLISHED_AT = 900;

function makeMeta(): SnapshotMetaEpic {
  return {
    schemaVersion: "1.0",
    epicLight: {
      id: EPIC_ID,
      title: "Nested sort clock",
      initialUserPrompt: "",
      ticketCount: 0,
      specCount: 0,
      storyCount: 0,
      reviewCount: 0,
      status: "open",
      createdAt: 0,
      updatedAt: 0,
      createdBy: "user",
      version: "1",
    },
    permissionRole: "editor",
    repos: [],
    workspaces: [],
    repoMapping: [],
    workspaceFolders: [],
    unresolvedRepos: [],
    hostStateVectorBase64: "AA==",
  };
}

/** A doc chat entry, with the `hostId` / `userId` a foreign row needs. */
function chat(args: {
  readonly id: string;
  readonly parentId: string | null;
  readonly hostId: string;
  readonly userId: string | null;
  readonly updatedAt: number;
}): Y.Map<unknown> {
  const entry = new Y.Map<unknown>();
  entry.set("id", args.id);
  entry.set("title", args.id);
  entry.set("parentId", args.parentId);
  entry.set("createdAt", 1);
  entry.set("updatedAt", args.updatedAt);
  entry.set("hostId", args.hostId);
  entry.set("userId", args.userId);
  entry.set("archivedAt", null);
  entry.set("messages", new Y.Array<unknown>());
  return entry;
}

/**
 * One parent, two FOREIGN children (`hostId: host-b`, session host
 * `host-a`): OLD at `updatedAt: 100`, NEW at `updatedAt: 200`, so the
 * projector's own default order under the parent - most-recent first - is
 * NEW, OLD before any record head arrives.
 */
function seedDoc(doc: Y.Doc): void {
  const chats = new Y.Map<unknown>();
  chats.set(
    PARENT_ID,
    chat({
      id: PARENT_ID,
      parentId: null,
      hostId: SESSION_HOST_ID,
      userId: null,
      updatedAt: 1,
    }),
  );
  chats.set(
    OLD_ID,
    chat({
      id: OLD_ID,
      parentId: PARENT_ID,
      hostId: FOREIGN_HOST_ID,
      userId: OWNER_USER_ID,
      updatedAt: OLD_UPDATED_AT,
    }),
  );
  chats.set(
    NEW_ID,
    chat({
      id: NEW_ID,
      parentId: PARENT_ID,
      hostId: FOREIGN_HOST_ID,
      userId: OWNER_USER_ID,
      updatedAt: NEW_UPDATED_AT,
    }),
  );
  const epic = doc.getMap("epic");
  epic.set("title", "Nested sort clock");
  epic.set("artifacts", new Y.Map<unknown>());
  epic.set("chats", chats);
}

function createSession(): OpenEpicStoreHandle {
  const captured: { value: EpicStreamCallbacks | null } = { value: null };
  const factory: EpicStreamClientFactory = (_epicId, callbacks) => {
    captured.value = callbacks;
    return {
      applyUpdate: () => undefined,
      awareness: () => undefined,
      applyArtifactRoomUpdate: () => undefined,
      artifactRoomAwareness: () => undefined,
      retryMigration: () => undefined,
      close: () => undefined,
    };
  };
  const handle = openStoreForTest({
    epicId: EPIC_ID,
    // `null`: this test's assertions are about ordering, not about the
    // owner-visibility filter the record slice applies to RECORD rows - a
    // non-null viewer here would additionally have to match `OWNER_USER_ID`
    // for the head-only delta below to overlay `chats.byId` at all.
    userId: null,
    // The factories go to the COMPOSITION now, not the store - see
    // `chat-records-union.test.ts`'s `newSession`.
    factories: {
      streamClientFactory: factory,
      laneSelection: null,
    },
    // Explicit: this suite never writes.
    writeCommand: null,
  });
  if (captured.value === null) throw new Error("stream factory not invoked");
  const donor = new Y.Doc();
  seedDoc(donor);
  captured.value.onSnapshot(makeMeta(), Y.encodeStateAsUpdate(donor));
  donor.destroy();
  return handle;
}

/** Mirrors the `record()` fixture helper in chat-records-union.test.ts. */
function record(
  overrides: Partial<ChatRecordSummaryV12>,
): ChatRecordSummaryV12 {
  return {
    chatId: OLD_ID,
    ownerUserId: OWNER_USER_ID,
    originHostId: FOREIGN_HOST_ID,
    title: OLD_ID,
    isTitleEditedByUser: false,
    parentChatId: PARENT_ID,
    createdAt: 1,
    updatedAt: OLD_UPDATED_AT,
    archived: false,
    archivedAt: null,
    runSettingsSummary: "claude",
    revision: 1,
    visibility: "task",
    origin: "foreign",
    // A registry-homed replica: this suite is about ordering, and the home
    // has no part in it.
    docResident: false,
    ...overrides,
  };
}

function headStamp(
  overrides: Partial<ChatRecordHeadStamp>,
): ChatRecordHeadStamp {
  return {
    headSha256: "a".repeat(64),
    throughRecordSeq: 1,
    publishedAt: 1_000,
    ...overrides,
  };
}

/**
 * Pushes a delta for OLD whose metadata mirrors the doc entry field-for-field
 * (same title, parent, timestamps, archive state) so overlaying the union
 * changes nothing OLD already displayed - the only new fact is the head. This
 * is the FIRST record this identity ever receives (OLD exists only as a doc
 * entry beforehand), so the record table takes it outright; what makes it read
 * as "head-only" is that every other field is unchanged from what the doc
 * projection already showed - the only new fact is the head, which lands on
 * its own plane.
 */
function applyHeadOnlyDeltaForOld(handle: OpenEpicStoreHandle): void {
  handle.store.getState().applyChatRecordDelta({
    kind: "upsert",
    epicId: EPIC_ID,
    record: record({ head: headStamp({ publishedAt: HEAD_PUBLISHED_AT }) }),
  });
}

function clockFor(handle: OpenEpicStoreHandle): NodeSortClock {
  const state = handle.store.getState();
  return localChatLastActiveAtById({
    chatsById: state.chats.byId,
    recordHeads: state.chatRecordHeads,
    sessionHostId: SESSION_HOST_ID,
    ownCloudChatByLocalId: new Map(),
  });
}

function walk(
  handle: OpenEpicStoreHandle,
  comparator: NodeComparator | null,
  clock: NodeSortClock | null,
): readonly string[] {
  return collectVisibleSidebarTreeIds({
    rootIds: [PARENT_ID],
    expandedIds: new Set([PARENT_ID]),
    tree: handle.store.getState().tree,
    treeFilter: CHATS_TREE_FILTER,
    emitFilter: CHATS_TREE_FILTER,
    visibleIds: null,
    comparator,
    clock,
  });
}

function Providers(props: {
  readonly handle: OpenEpicStoreHandle;
  readonly comparator: NodeComparator | null;
  readonly clock: NodeSortClock | null;
  readonly children: ReactNode;
}): ReactNode {
  return (
    <EpicSessionContext.Provider value={props.handle}>
      <SidebarSortContext.Provider value={props.comparator}>
        <SidebarSortClockContext.Provider value={props.clock}>
          {props.children}
        </SidebarSortClockContext.Provider>
      </SidebarSortContext.Provider>
    </EpicSessionContext.Provider>
  );
}

afterEach(() => {
  cleanup();
});

describe("nested sidebar rows reorder on a head-only delta", () => {
  it("collectVisibleSidebarTreeIds moves the child whose head advanced, in default and explicit-activity modes", () => {
    const handle = createSession();
    try {
      // Sanity: the projector's own default order (most-recent first) has
      // NEW before OLD - the claim this whole test is built on.
      expect(handle.store.getState().tree.childrenByParent[PARENT_ID]).toEqual([
        NEW_ID,
        OLD_ID,
      ]);

      const clockBefore = clockFor(handle);
      expect(clockBefore.size).toBe(0);

      // DEFAULT mode (comparator: null), before the delta: unaffected by an
      // empty clock, same as the projector's own order.
      expect(walk(handle, null, clockBefore)).toEqual([
        PARENT_ID,
        NEW_ID,
        OLD_ID,
      ]);

      const ascending = makeNodeComparator({
        field: SORT_FIELD.Updated,
        direction: SORT_DIRECTION.Asc,
      });
      // Explicit activity-ascending mode, before the delta: raw `updatedAt`
      // ascending is OLD (100) then NEW (200).
      expect(walk(handle, ascending, null)).toEqual([
        PARENT_ID,
        OLD_ID,
        NEW_ID,
      ]);

      applyHeadOnlyDeltaForOld(handle);

      const clockAfter = clockFor(handle);
      expect(clockAfter.get(OLD_ID)).toBe(HEAD_PUBLISHED_AT);
      expect(clockAfter.has(NEW_ID)).toBe(false);

      // DEFAULT mode, WITH the clock: OLD's publication (900) outranks NEW's
      // raw `updatedAt` (200), so OLD floats above NEW under the parent.
      expect(walk(handle, null, clockAfter)).toEqual([
        PARENT_ID,
        OLD_ID,
        NEW_ID,
      ]);

      // Explicit activity-ascending mode, WITH the clock: OLD's effective
      // stamp (900) now sorts LAST ascending, flipping the pre-delta order.
      expect(walk(handle, ascending, clockAfter)).toEqual([
        PARENT_ID,
        NEW_ID,
        OLD_ID,
      ]);

      // CONTROL: same post-delta store, clock withheld - the order is
      // unaffected by the delta, proving the reorder above is the clock's
      // doing and not some other side effect of the delta.
      expect(walk(handle, null, null)).toEqual([PARENT_ID, NEW_ID, OLD_ID]);
      expect(walk(handle, ascending, null)).toEqual([
        PARENT_ID,
        OLD_ID,
        NEW_ID,
      ]);
    } finally {
      handle.dispose();
    }
  });

  it("useFilteredPanelChildIds sorts by the same clock through SidebarSortClockContext", () => {
    const handle = createSession();
    try {
      applyHeadOnlyDeltaForOld(handle);
      const clock = clockFor(handle);
      expect(clock.get(OLD_ID)).toBe(HEAD_PUBLISHED_AT);

      const withClock = renderHook(
        () => useFilteredPanelChildIds(PARENT_ID, CHATS_TREE_FILTER),
        {
          wrapper: (props: { readonly children: ReactNode }) => (
            <Providers handle={handle} comparator={null} clock={clock}>
              {props.children}
            </Providers>
          ),
        },
      );
      // The parent never appears in its own child list, and the two children
      // are exactly OLD and NEW, OLD first now that its head is the newer
      // publication.
      expect(withClock.result.current).toEqual([OLD_ID, NEW_ID]);
      expect(withClock.result.current).not.toContain(PARENT_ID);
      expect(withClock.result.current).toHaveLength(2);

      const ascending = makeNodeComparator({
        field: SORT_FIELD.Updated,
        direction: SORT_DIRECTION.Asc,
      });
      const ascendingWithClock = renderHook(
        () => useFilteredPanelChildIds(PARENT_ID, CHATS_TREE_FILTER),
        {
          wrapper: (props: { readonly children: ReactNode }) => (
            <Providers handle={handle} comparator={ascending} clock={clock}>
              {props.children}
            </Providers>
          ),
        },
      );
      expect(ascendingWithClock.result.current).toEqual([NEW_ID, OLD_ID]);

      // CONTROL: no `SidebarSortClockContext.Provider` in the tree at all, so
      // the hook reads its default (`null`) clock - the child order stays the
      // projector's own default, NEW then OLD, unmoved by the delta.
      const withoutClockWrapper = (props: {
        readonly children: ReactNode;
      }): ReactNode => (
        <EpicSessionContext.Provider value={handle}>
          {props.children}
        </EpicSessionContext.Provider>
      );
      const withoutClock = renderHook(
        () => useFilteredPanelChildIds(PARENT_ID, CHATS_TREE_FILTER),
        { wrapper: withoutClockWrapper },
      );
      expect(withoutClock.result.current).toEqual([NEW_ID, OLD_ID]);
    } finally {
      handle.dispose();
    }
  });
});
