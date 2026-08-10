/**
 * Independent acceptance suite — seams S8 and S9 (GUI half).
 *
 * S8 pins the output window's persisted shape to what `UI.md` §9a promises:
 * a renderer-local pointer of exactly `{ id: commandId, instanceId, type,
 * hostId }`, with kind/description/status re-read live on restore, and
 * NOTHING written to the epic doc. The key-set assertion is the fence that
 * keeps state from creeping into storage later.
 *
 * S9 (GUI) is the readout join (`UI.md` §6): CPU/mem chips appear on the rows
 * of a chat's Shells menu for commands the resources stream names, absence
 * means "untracked" (never zero), and a pre-@1.4 host's frames — which cannot
 * carry a managed-command owner at all — degrade to no chip rather than a
 * wrong one. The old-peer fold itself and its frame invariant are proven
 * host-side in `traycer-host/.../managed-command-ui-acceptance.test.ts`
 * (S9a-c).
 */
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ManagedCommandChatMenu } from "@/components/managed-commands/managed-command-chat-menu";
import { EpicSessionContext } from "@/lib/registries/epic-session-registry";
import {
  createOpenEpicStore,
  type EpicStreamClientFactory,
  type OpenEpicStoreHandle,
} from "@/stores/epics/open-epic/store";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import {
  makeManagedCommandOutputTileRef,
  managedCommandOutputTileSchema,
} from "@/stores/epics/canvas/tile-schema/managed-command-output-tile";
import { TILE_KIND_MANAGED_COMMAND_OUTPUT } from "@/stores/epics/canvas/tile-kinds";
import {
  disposeManagedCommandChatSessions,
  installManagedCommandChatSession,
  type ManagedCommandChatSessionStub,
} from "@/stores/managed-commands/test-support/managed-command-chat-session";
import { ResourcesStreamMount } from "@/providers/resources-stream-mount";
import { __setResourcesStreamClientFactoryForTests } from "@/providers/resources-stream-factory-override";
import { resourcesRegistry } from "@/stores/resources/resources-registry";
import { useSettingsStore } from "@/stores/settings/settings-store";
import type {
  ResourcesProjectionPayload,
  ResourcesStreamCallbacks,
} from "@traycer-clients/shared/host-transport/resources-stream-client";
import { chatSubscribeServerFrameSchema } from "@traycer/protocol/host/agent/gui/subscribe";
import { managedCommandSchema } from "@traycer/protocol/host/managed-command/unary-schemas";
import type { ManagedCommand } from "@traycer/protocol/host/managed-command/unary-schemas";
import {
  resourcesSubscribeServerFrameSchemaV12,
  resourcesSubscribeServerFrameSchemaV14,
} from "@traycer/protocol/host/resources/subscribe";

const mocks = vi.hoisted(() => ({
  startMutate: vi.fn(),
  stopMutate: vi.fn(),
  deleteMutate: vi.fn(),
}));

vi.mock("@/lib/host/stream-runtime-context", () => ({
  useWsStreamClient: () => null,
  useStreamMethodSupport: () => "supported",
  useStreamMethodSchemaVersion: () => null,
}));

vi.mock("@/hooks/host/use-reactive-active-host-id", () => ({
  useReactiveActiveHostId: () => "host-1",
}));

vi.mock(
  "@/hooks/managed-command/use-managed-command-lifecycle-mutations",
  () => ({
    useManagedCommandStart: () => ({
      mutate: mocks.startMutate,
      isPending: false,
    }),
    useManagedCommandStop: () => ({
      mutate: mocks.stopMutate,
      isPending: false,
    }),
    useManagedCommandDelete: () => ({
      mutate: mocks.deleteMutate,
      isPending: false,
    }),
    useManagedCommandStopAllIsPending: () => false,
  }),
);

const EPIC_ID = "epic-s8";
const TAB_ID = "tab-s8";
const HOST_ID = "host-1";
// The menu is a chat's own surface, so its rows are exactly the commands this
// chat owns — the fixtures below and the menu have to name the same chat.
const CHAT_ID = "chat-owner";
const T0 = 1_722_000_000_000;
const MiB = 1024 * 1024;

const noopEpicStreamClientFactory: EpicStreamClientFactory = () => ({
  applyUpdate: () => undefined,
  awareness: () => undefined,
  applyArtifactRoomUpdate: () => undefined,
  artifactRoomAwareness: () => undefined,
  retryMigration: () => undefined,
  close: () => undefined,
});

let chatSession: ManagedCommandChatSessionStub | null = null;
let resourcesWire: ResourcesStreamCallbacks | null = null;
let epicHandle: OpenEpicStoreHandle | null = null;

function makeCommand(over: Partial<ManagedCommand>): ManagedCommand {
  return managedCommandSchema.parse({
    id: "cmd-res",
    monitoring: true,
    description: "deploy watcher",
    status: { state: "running", pid: 4410, startedAtMs: T0 },
    chatId: CHAT_ID,
    createdAtMs: T0,
    updatedAtMs: T0,
    ...over,
  });
}

/**
 * The chat's whole set, authored through the wire schema. The resource chips
 * join by `commandId` off the resources stream and know nothing about where
 * the command records came from, which is what S9 is about.
 */
function emitCommands(commands: readonly ManagedCommand[]): void {
  if (chatSession === null) throw new Error("chat session never installed");
  const frame = chatSubscribeServerFrameSchema.parse({
    kind: "managedCommandsChanged",
    hasBinaryPayload: false,
    epicId: EPIC_ID,
    chatId: CHAT_ID,
    managedCommands: commands,
  });
  if (frame.kind !== "managedCommandsChanged") {
    throw new Error("unreachable");
  }
  const session = chatSession;
  act(() => {
    session.setCommands(frame.managedCommands);
  });
}

/** A @1.4 owner row naming a managed command, quantization-fixed-point values. */
function managedCommandOwnerRow(commandId: string): Record<string, unknown> {
  return {
    owner: {
      kind: "managed-command",
      hostId: HOST_ID,
      epicId: EPIC_ID,
      ownerId: commandId,
    },
    sampledAt: T0,
    rootPids: [4410],
    activeProcessName: "sleep",
    processCount: 2,
    cpuPercent: 7,
    rssBytes: 64 * MiB,
    processes: [],
    harnessId: null,
    managedCommand: {
      commandId,
      monitoring: true,
      description: "deploy watcher",
      createdByAgentId: CHAT_ID,
    },
  };
}

/**
 * Authors a @1.4 snapshot/update frame, parses it through the frozen V14
 * schema, and hands the client-side payload to the captured callbacks — the
 * same 1:1 projection the real stream client performs for a @1.4 host.
 */
function emitResourcesV14(
  kind: "snapshot" | "update",
  owners: readonly Record<string, unknown>[],
): void {
  if (resourcesWire === null) throw new Error("resources stream never opened");
  const frame = resourcesSubscribeServerFrameSchemaV14.parse({
    kind,
    hasBinaryPayload: false,
    epicId: EPIC_ID,
    sampledAt: T0,
    app: null,
    owners,
    epic: null,
    epics: [],
    hostTree: null,
    other: null,
  });
  if (frame.kind === "pong") throw new Error("unreachable");
  const payload: ResourcesProjectionPayload = {
    epicId: frame.epicId,
    sampledAt: frame.sampledAt,
    app: frame.app,
    owners: frame.owners,
    epic: frame.epic,
    epics: frame.epics ?? [],
    hostTree: frame.hostTree,
    other: frame.other,
  };
  const callbacks = resourcesWire;
  act(() => {
    if (kind === "snapshot") callbacks.onSnapshot(payload);
    else callbacks.onUpdate(payload);
  });
}

/**
 * Authors the frame a pre-@1.4 host would send — parsed through the frozen
 * V12 schema, so a managed-command owner could not even be expressed — and
 * backfills the keys the client's own contract documents as null-backfilled.
 */
function emitResourcesOldHost(): void {
  if (resourcesWire === null) throw new Error("resources stream never opened");
  const frame = resourcesSubscribeServerFrameSchemaV12.parse({
    kind: "snapshot",
    hasBinaryPayload: false,
    epicId: EPIC_ID,
    sampledAt: T0,
    app: null,
    owners: [
      {
        owner: {
          kind: "chat",
          hostId: HOST_ID,
          epicId: EPIC_ID,
          ownerId: CHAT_ID,
        },
        sampledAt: T0,
        rootPids: [4100],
        activeProcessName: "node",
        processCount: 1,
        cpuPercent: 3,
        rssBytes: 32 * MiB,
        processes: [],
      },
    ],
    epic: null,
    epics: [],
    hostTree: null,
    other: null,
  });
  if (frame.kind === "pong") throw new Error("unreachable");
  const payload: ResourcesProjectionPayload = {
    epicId: frame.epicId,
    sampledAt: frame.sampledAt,
    app: frame.app,
    owners: frame.owners.map((owner) => ({
      ...owner,
      harnessId: null,
      managedCommand: null,
    })),
    epic: frame.epic,
    epics: frame.epics ?? [],
    hostTree: frame.hostTree,
    other: frame.other,
  };
  const callbacks = resourcesWire;
  act(() => {
    callbacks.onSnapshot(payload);
  });
}

function renderMenuWithResources(): void {
  epicHandle = createOpenEpicStore({
    epicId: EPIC_ID,
    streamClientFactory: noopEpicStreamClientFactory,
    userId: null,
    onAuthError: null,
  });
  render(
    <EpicSessionContext.Provider value={epicHandle}>
      <TooltipProvider>
        <ResourcesStreamMount epicId={EPIC_ID} />
        <ManagedCommandChatMenu
          epicId={EPIC_ID}
          chatId={CHAT_ID}
          hostId={HOST_ID}
          viewTabId={TAB_ID}
        />
      </TooltipProvider>
    </EpicSessionContext.Provider>,
  );
}

/**
 * The menu's trigger only exists once the chat owns something, so the command
 * frame has to land before this — the rows are inside a popover that is not
 * rendered at all until it is opened.
 */
function openMenu(): void {
  // Prefix match: the trigger's accessible name carries the live counts
  // ("Shells, 2 running").
  fireEvent.click(screen.getByRole("button", { name: /^Shells/ }));
}

function chipOnRow(commandId: string): HTMLElement | null {
  // The row's door is a button covering the title alone - the chip is its
  // sibling inside the row, so scope to the whole list item.
  const row = screen
    .getByTestId(`managed-command-menu-row-${commandId}`)
    .closest("li");
  return (
    row?.querySelector<HTMLElement>('[data-slot="resource-usage-chip"]') ?? null
  );
}

beforeEach(() => {
  useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
  useEpicCanvasStore.setState({
    tabsById: { [TAB_ID]: { tabId: TAB_ID, epicId: EPIC_ID, name: "Epic" } },
    openTabOrder: [TAB_ID],
    activeTabId: TAB_ID,
  });
  useSettingsStore.setState({ showNavigatorResourceStats: true });
  chatSession = installManagedCommandChatSession({
    epicId: EPIC_ID,
    chatId: CHAT_ID,
  });
  __setResourcesStreamClientFactoryForTests((_scope, callbacks) => {
    resourcesWire = callbacks;
    return { close: () => undefined };
  });
});

afterEach(() => {
  cleanup();
  __setResourcesStreamClientFactoryForTests(null);
  disposeManagedCommandChatSessions();
  chatSession = null;
  resourcesRegistry.disposeAll();
  epicHandle?.dispose();
  epicHandle = null;
  resourcesWire = null;
  useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
  vi.clearAllMocks();
});

describe("S8 · tile-ref minimalism", () => {
  it("S8a: the persisted ref is exactly { id: commandId, instanceId, type, hostId } — nothing else can ride along", () => {
    const ref = makeManagedCommandOutputTileRef({
      commandId: "cmd-pin",
      hostId: HOST_ID,
    });
    const persisted = managedCommandOutputTileSchema.serialize(ref);
    if (persisted === null || typeof persisted !== "object") {
      throw new Error("expected an object");
    }
    // UI.md §9a pins this exact key set.
    expect(Object.keys(persisted).sort()).toEqual([
      "hostId",
      "id",
      "instanceId",
      "type",
    ]);
    expect(persisted).toMatchObject({
      id: "cmd-pin",
      type: TILE_KIND_MANAGED_COMMAND_OUTPUT,
      hostId: HOST_ID,
    });
  });

  it("S8b: state smuggled into storage is dropped on parse — kind, description and status stay live-only", () => {
    const parsed = managedCommandOutputTileSchema.parse({
      id: "cmd-creep",
      instanceId: "instance-1",
      type: TILE_KIND_MANAGED_COMMAND_OUTPUT,
      hostId: HOST_ID,
      // The creep §9a rules out — none of it may survive a round-trip.
      monitoring: true,
      description: "deploy watcher",
      status: { state: "running", pid: 4410 },
      name: "Shell · deploy watcher",
    });
    expect(parsed).not.toBeNull();
    if (parsed === null) throw new Error("unreachable");
    const reserialized = managedCommandOutputTileSchema.serialize(parsed);
    if (reserialized === null || typeof reserialized !== "object") {
      throw new Error("expected an object");
    }
    expect(Object.keys(reserialized).sort()).toEqual([
      "hostId",
      "id",
      "instanceId",
      "type",
    ]);
  });

  it("S8c: a ref that lost its command or host is rejected, not defaulted", () => {
    expect(
      managedCommandOutputTileSchema.parse({
        instanceId: "instance-1",
        type: TILE_KIND_MANAGED_COMMAND_OUTPUT,
        hostId: HOST_ID,
      }),
    ).toBeNull();
    expect(
      managedCommandOutputTileSchema.parse({
        id: "cmd-x",
        instanceId: "instance-1",
        type: TILE_KIND_MANAGED_COMMAND_OUTPUT,
        hostId: "",
      }),
    ).toBeNull();
  });

  it("S8d: opening an output window writes nothing to the epic doc", () => {
    epicHandle = createOpenEpicStore({
      epicId: EPIC_ID,
      streamClientFactory: noopEpicStreamClientFactory,
      userId: null,
      onAuthError: null,
    });
    let docUpdates = 0;
    epicHandle.doc.on("update", () => {
      docUpdates += 1;
    });

    useEpicCanvasStore.getState().openTileInTab(
      TAB_ID,
      makeManagedCommandOutputTileRef({
        commandId: "cmd-doc",
        hostId: HOST_ID,
      }),
    );

    // The window exists on the canvas…
    const canvas = useEpicCanvasStore.getState().canvasByTabId[TAB_ID];
    const tiles = Object.values(canvas?.tilesByInstanceId ?? {});
    expect(tiles.some((ref) => ref !== undefined && ref.id === "cmd-doc")).toBe(
      true,
    );
    // …and the epic doc never heard about it (UI.md §9a: zero protocol /
    // persistence surface; invisible to other users by construction).
    expect(docUpdates).toBe(0);
  });
});

describe("S9 · resource readouts (GUI half)", () => {
  it("S9d: a tracked running command gets a CPU/mem readout on its menu row; an untracked one shows nothing, never zero", () => {
    renderMenuWithResources();
    emitCommands([
      makeCommand({ id: "cmd-res" }),
      makeCommand({ id: "cmd-quiet", description: "quiet watcher" }),
    ]);
    emitResourcesV14("snapshot", [managedCommandOwnerRow("cmd-res")]);
    openMenu();

    const chip = chipOnRow("cmd-res");
    expect(chip).not.toBeNull();
    // Authored at quantization fixed points, so the readout must carry the
    // authored values: 7% CPU, 64 MiB resident.
    expect(chip?.textContent).toMatch(/7(\.0)?%/);
    expect(chip?.textContent).toMatch(/64(\.0)?\s?MB/);

    // Absent snapshot means "not currently tracked" — no chip, no zeros.
    expect(chipOnRow("cmd-quiet")).toBeNull();
  });

  it("S9e: readouts follow the stream — an update moves the numbers, a command dropping out clears its chip", () => {
    renderMenuWithResources();
    emitCommands([makeCommand({ id: "cmd-res" })]);
    emitResourcesV14("snapshot", [managedCommandOwnerRow("cmd-res")]);
    openMenu();
    expect(chipOnRow("cmd-res")?.textContent).toMatch(/7(\.0)?%/);

    emitResourcesV14("update", [
      { ...managedCommandOwnerRow("cmd-res"), cpuPercent: 12 },
    ]);
    expect(chipOnRow("cmd-res")?.textContent).toMatch(/12%/);

    emitResourcesV14("update", []);
    expect(chipOnRow("cmd-res")).toBeNull();
  });

  it("S9f: a pre-@1.4 host cannot name a managed-command owner — its frames leave menu rows readout-free rather than wrong", () => {
    renderMenuWithResources();
    emitCommands([makeCommand({ id: "cmd-res" })]);
    emitResourcesOldHost();
    openMenu();

    // The row still says everything the chat's set knows — only the readout
    // the old host could not express is missing.
    expect(screen.getByText("Monitor · deploy watcher")).toBeTruthy();
    expect(chipOnRow("cmd-res")).toBeNull();
  });
});
