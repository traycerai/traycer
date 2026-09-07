/**
 * Pins `resolveChatWriteRoute` at the seam that combines host record-plane support with the row's `chatsById` fact.
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  recordNegotiatedHostMethods,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import { resolveChatWriteRoute } from "@/hooks/epic/use-chat-write-route";
import type { ChatProjection } from "@/stores/epics/open-epic/types";

const RECORD_PLANE_HOST = "host-record-plane";
const FLOOR_ERA_HOST = "host-floor-era";

/** A `ChatProjection` literal with every field populated explicitly. */
function chat(id: string, docResident: boolean | null): ChatProjection {
  return {
    id,
    title: id,
    parentId: null,
    createdAt: 0,
    updatedAt: 0,
    userId: null,
    hostId: RECORD_PLANE_HOST,
    isTitleEditedByUser: false,
    docResident,
    settings: null,
    archivedAt: null,
  };
}

beforeEach(() => {
  // Process-wide module state: without this, one test's recorded host
  // decides another test's verdict and the failure reads as a resolver bug.
  resetNegotiatedManifests();
});

describe("resolveChatWriteRoute", () => {
  it("floor-era host + doc-homed chat -> registry-rpc (the RPC resolves doc chats itself there)", () => {
    // No handshake recorded for this host at all: `readEpicDocRecordArms`
    // reads that as "the doc is still a source", so the row's own
    // `docResident: true` says nothing about addressability here.
    const chatsById = { "chat-1": chat("chat-1", true) };

    const route = resolveChatWriteRoute({
      chatsById,
      isChatRow: true,
      nodeId: "chat-1",
      sessionHostId: FLOOR_ERA_HOST,
    });

    expect(route).toBe("registry-rpc");
  });

  it("record-plane host + docResident: true -> unavailable", () => {
    recordNegotiatedHostMethods(RECORD_PLANE_HOST, ["epic.listChatRecords"]);
    const chatsById = { "chat-1": chat("chat-1", true) };

    const route = resolveChatWriteRoute({
      chatsById,
      isChatRow: true,
      nodeId: "chat-1",
      sessionHostId: RECORD_PLANE_HOST,
    });

    expect(route).toBe("unavailable");
  });

  it("record-plane host + docResident: null (delta-plane base row, home unstated) -> unavailable", () => {
    recordNegotiatedHostMethods(RECORD_PLANE_HOST, ["epic.listChatRecords"]);
    const chatsById = { "chat-1": chat("chat-1", null) };

    const route = resolveChatWriteRoute({
      chatsById,
      isChatRow: true,
      nodeId: "chat-1",
      sessionHostId: RECORD_PLANE_HOST,
    });

    expect(route).toBe("unavailable");
  });

  it("record-plane host + docResident: false -> registry-rpc (without this, the two disabled pins above would pass against a gate that refuses everything)", () => {
    recordNegotiatedHostMethods(RECORD_PLANE_HOST, ["epic.listChatRecords"]);
    const chatsById = { "chat-1": chat("chat-1", false) };

    const route = resolveChatWriteRoute({
      chatsById,
      isChatRow: true,
      nodeId: "chat-1",
      sessionHostId: RECORD_PLANE_HOST,
    });

    expect(route).toBe("registry-rpc");
  });

  it("the null -> stated transition re-enables the affordance on the next call, with no re-open needed", () => {
    recordNegotiatedHostMethods(RECORD_PLANE_HOST, ["epic.listChatRecords"]);

    const unstated = resolveChatWriteRoute({
      chatsById: { "chat-1": chat("chat-1", null) },
      isChatRow: true,
      nodeId: "chat-1",
      sessionHostId: RECORD_PLANE_HOST,
    });
    expect(unstated).toBe("unavailable");

    const stated = resolveChatWriteRoute({
      chatsById: { "chat-1": chat("chat-1", false) },
      isChatRow: true,
      nodeId: "chat-1",
      sessionHostId: RECORD_PLANE_HOST,
    });
    expect(stated).toBe("registry-rpc");
  });

  it("a non-chat row is always registry-rpc, even on a record-plane host with no matching row", () => {
    // `isChatRow: false` must short-circuit before the row lookup even runs.
    // The sidebar row component is polymorphic; an ungated call would find no chat row for a terminal agent or artifact id and disable its affordance on any host with a record plane.
    recordNegotiatedHostMethods(RECORD_PLANE_HOST, ["epic.listChatRecords"]);

    const route = resolveChatWriteRoute({
      chatsById: {},
      isChatRow: false,
      nodeId: "terminal-agent-1",
      sessionHostId: RECORD_PLANE_HOST,
    });

    expect(route).toBe("registry-rpc");
  });

  it("a chat missing from the union entirely -> unavailable on a record-plane host", () => {
    recordNegotiatedHostMethods(RECORD_PLANE_HOST, ["epic.listChatRecords"]);

    const route = resolveChatWriteRoute({
      chatsById: {},
      isChatRow: true,
      nodeId: "chat-missing",
      sessionHostId: RECORD_PLANE_HOST,
    });

    expect(route).toBe("unavailable");
  });

  it("sessionHostId: null -> registry-rpc for a chat (readEpicDocRecordArms(null) is DOC_IS_THE_ONLY_RECORD_SOURCE, the same fact-one-satisfied outcome as an unrecorded handshake)", () => {
    // The brief for this pin predicted "unavailable", reasoning that an unbound session should fail closed the same direction as an unrecorded handshake.
    const chatsById = { "chat-1": chat("chat-1", false) };

    const route = resolveChatWriteRoute({
      chatsById,
      isChatRow: true,
      nodeId: "chat-1",
      sessionHostId: null,
    });

    expect(route).toBe("registry-rpc");
  });
});
