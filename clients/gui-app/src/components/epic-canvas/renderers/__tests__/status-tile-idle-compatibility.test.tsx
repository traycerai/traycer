import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import type { EpicNodeRef } from "@/stores/epics/canvas/types";
import type { OpenedStoreForTest } from "@/stores/epics/open-epic/test-support/open-store-for-test";
import { createArtifactInDocForTests } from "@/stores/epics/open-epic/__tests__/projection-helpers-test-shims";
import type { EpicStreamCallbacks } from "@traycer-clients/shared/host-transport/epic-stream-client";
import { openStoreForTest } from "@/stores/epics/open-epic/test-support/open-store-for-test";
import type { EpicStreamClientFactory } from "@/stores/epics/open-epic/store";

const mocks = vi.hoisted(() => ({
  handle: { current: null as OpenedStoreForTest | null },
  snapshotMeta: null as { readonly epicLight: { readonly id: string } } | null,
  permissionRole: "editor" as "editor" | "viewer",
}));

vi.mock("@/providers/use-open-epic-handle", () => ({
  useOpenEpicHandle: () => {
    if (mocks.handle.current === null)
      throw new Error("missing session handle");
    return mocks.handle.current;
  },
}));

vi.mock("@/lib/epic-selectors", () => ({
  useEpicSnapshotMeta: () => mocks.snapshotMeta,
  useEpicArtifact: () => null,
  useEpicPermissionRole: () => mocks.permissionRole,
  useEpicConnectionStatus: () => "open",
}));

vi.mock("../collab-tile-body", () => ({ CollabTileBody: () => null }));
vi.mock("../artifact-version-history", () => ({
  ArtifactVersionHistoryEntryPoint: () => null,
}));

import { StoryTile } from "../story-tile";
import { TicketTile } from "../ticket-tile";

const EPIC_ID = "epic-status-idle-compatibility";

function encodeBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

function openHandle(): OpenedStoreForTest {
  const callbacks: { current: EpicStreamCallbacks | null } = { current: null };
  const streamClientFactory: EpicStreamClientFactory = (_epicId, next) => {
    callbacks.current = next;
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
    userId: null,
    factories: { streamClientFactory, laneSelection: null },
    writeCommand: () => new Promise<{ readonly hostId: string }>(() => {}),
  });
  if (callbacks.current === null)
    throw new Error("stream factory did not open");
  callbacks.current.onConnectionStatus("open", null, false, null);
  callbacks.current.onSnapshot(
    {
      schemaVersion: "1.0",
      epicLight: {
        id: EPIC_ID,
        title: "Test task",
        initialUserPrompt: "",
        ticketCount: 0,
        specCount: 0,
        storyCount: 0,
        reviewCount: 0,
        status: "open",
        createdAt: 0,
        updatedAt: 0,
        createdBy: "test-user",
        version: "1",
      },
      permissionRole: "editor",
      repos: [],
      workspaces: [],
      repoMapping: [],
      workspaceFolders: [],
      unresolvedRepos: [],
      hostStateVectorBase64: encodeBase64(Y.encodeStateVector(new Y.Doc())),
    },
    Y.encodeStateAsUpdate(new Y.Doc()),
  );
  mocks.handle.current = handle;
  return handle;
}

afterEach(() => {
  cleanup();
  mocks.handle.current?.dispose();
  mocks.handle.current = null;
  mocks.snapshotMeta = null;
  mocks.permissionRole = "editor";
});

function statusNode(
  kind: "ticket" | "story",
  artifactId: string,
  instanceId: string,
): EpicNodeRef {
  return {
    id: artifactId,
    instanceId,
    type: kind,
    name: "Test artifact",
    hostId: "test-host",
  };
}

describe("idle artifact status controls without snapshot metadata", () => {
  it.each(["ticket", "story"] as const)(
    "%s stays enabled without snapshot metadata and submits picks by pointer and keyboard",
    async (kind) => {
      const handle = openHandle();
      const pointerArtifactId = createArtifactInDocForTests(
        handle.doc,
        kind,
        null,
      );
      const keyboardArtifactId = createArtifactInDocForTests(
        handle.doc,
        kind,
        null,
      );
      const Tile = kind === "ticket" ? TicketTile : StoryTile;
      render(
        <>
          <Tile
            node={statusNode(kind, pointerArtifactId, `${kind}-pointer`)}
            viewTabId="view-test"
            tileId={`${kind}-pointer`}
            isActive
          />
          <Tile
            node={statusNode(kind, keyboardArtifactId, `${kind}-keyboard`)}
            viewTabId="view-test"
            tileId={`${kind}-keyboard`}
            isActive
          />
        </>,
      );

      const [pointerTrigger, keyboardTrigger] =
        screen.getAllByTestId("status-pill");
      if (
        !(pointerTrigger instanceof HTMLButtonElement) ||
        !(keyboardTrigger instanceof HTMLButtonElement)
      ) {
        throw new Error("expected both status trigger buttons");
      }
      expect(pointerTrigger.disabled).toBe(false);
      expect(keyboardTrigger.disabled).toBe(false);
      expect(handle.store.getState().occupiedWriteFields).toEqual({});

      fireEvent.pointerDown(pointerTrigger, { button: 0, ctrlKey: false });
      fireEvent.click(await screen.findByTestId("status-option-2"));
      await act(async () => handle.flush());

      fireEvent.keyDown(keyboardTrigger, { key: "Enter" });
      fireEvent.click(await screen.findByTestId("status-option-2"));
      await act(async () => handle.flush());

      expect(
        handle.store
          .getState()
          .writeCommands.some(
            (command) =>
              command.intent.kind === "update-artifact-status" &&
              command.intent.artifactId === pointerArtifactId,
          ),
      ).toBe(true);
      expect(
        handle.store
          .getState()
          .writeCommands.some(
            (command) =>
              command.intent.kind === "update-artifact-status" &&
              command.intent.artifactId === keyboardArtifactId,
          ),
      ).toBe(true);
    },
  );
});

describe("occupied artifact status controls", () => {
  it("blocks pointer and keyboard menu entry while the status field is occupied", async () => {
    const handle = openHandle();
    const artifactId = createArtifactInDocForTests(handle.doc, "ticket", null);
    mocks.snapshotMeta = { epicLight: { id: EPIC_ID } };
    handle.store.setState({
      occupiedWriteFields: { [`status:${artifactId}`]: true },
    });
    const node = statusNode("ticket", artifactId, "busy-ticket-one");
    const twin = statusNode("ticket", artifactId, "busy-ticket-two");
    render(
      <>
        <TicketTile
          node={node}
          viewTabId="view-test"
          tileId="busy-one"
          isActive
        />
        <TicketTile
          node={twin}
          viewTabId="view-test"
          tileId="busy-two"
          isActive
        />
      </>,
    );

    const triggers = screen.getAllByTestId("status-pill");
    expect(triggers).toHaveLength(2);
    for (const trigger of triggers) {
      if (!(trigger instanceof HTMLButtonElement))
        throw new Error("expected a status trigger button");
      expect(trigger.disabled).toBe(true);
      fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
      fireEvent.keyDown(trigger, { key: "Enter" });
    }
    expect(screen.queryByTestId("status-option-2")).toBeNull();
    await handle.flush();
    expect(
      handle.store
        .getState()
        .writeCommands.filter(
          (command) => command.intent.kind === "update-artifact-status",
        ),
    ).toHaveLength(0);
  });

  it("disables an already-open menu item before a pick can submit", async () => {
    const handle = openHandle();
    const artifactId = createArtifactInDocForTests(handle.doc, "story", null);
    mocks.snapshotMeta = { epicLight: { id: EPIC_ID } };
    const node = {
      id: artifactId,
      instanceId: "open-story-menu",
      type: "story",
      name: "Test artifact",
      hostId: "test-host",
    } satisfies EpicNodeRef;
    render(
      <StoryTile
        node={node}
        viewTabId="view-test"
        tileId="tile-test"
        isActive
      />,
    );

    const trigger = screen.getByTestId("status-pill");
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
    const option = await screen.findByTestId("status-option-2");
    act(() => {
      handle.store.setState({
        occupiedWriteFields: { [`status:${artifactId}`]: true },
      });
    });
    expect(option.getAttribute("data-disabled")).toBe("");
    fireEvent.click(option);
    await act(async () => handle.flush());

    expect(
      handle.store
        .getState()
        .writeCommands.filter(
          (command) => command.intent.kind === "update-artifact-status",
        ),
    ).toHaveLength(0);
  });
});

describe("read-only artifact status controls", () => {
  it.each(["ticket", "story"] as const)(
    "%s keeps a non-interactive status presentation",
    (kind) => {
      const handle = openHandle();
      const artifactId = createArtifactInDocForTests(handle.doc, kind, null);
      mocks.permissionRole = "viewer";
      const Tile = kind === "ticket" ? TicketTile : StoryTile;
      render(
        <Tile
          node={statusNode(kind, artifactId, `readonly-${kind}`)}
          viewTabId="view-test"
          tileId={`readonly-${kind}`}
          isActive
        />,
      );

      const label = screen.getByText("Todo");
      expect(label.tagName).toBe("SPAN");
      fireEvent.pointerDown(label, { button: 0, ctrlKey: false });
      fireEvent.keyDown(label, { key: "Enter" });
      expect(screen.queryByTestId("status-pill")).toBeNull();
      expect(screen.queryByTestId("status-option-2")).toBeNull();
      expect(handle.store.getState().occupiedWriteFields).toEqual({});
    },
  );
});
