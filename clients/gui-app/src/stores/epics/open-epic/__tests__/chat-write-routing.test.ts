/**
 * The chat write-routing predicate, pinned across the three host classes the
 * released floor makes reachable.
 *
 * The whole point of the predicate is that a row's stated home is NOT enough on
 * its own: `epic.renameChat`, `epic.reparentChat` and `epic.deleteChat` are all
 * on `RELEASED_FLOOR_METHOD_NAMES`, so they exist and work on a host with no
 * chat registry at all - and on that host every chat projects from the doc. A
 * home-only gate would disable every chat affordance on exactly the hosts where
 * the RPC needs no gate.
 */
import { describe, expect, it } from "vitest";
import {
  DOC_IS_THE_ONLY_RECORD_SOURCE,
  RECORD_PLANE_COVERS_BOTH,
} from "@/stores/epics/open-epic/projection-helpers";
import {
  routeChatWrite,
  type ChatWriteRoute,
} from "@/stores/epics/open-epic/chat-write-routing";
import type { ChatProjection } from "@/stores/epics/open-epic/types";

function chat(docResident: boolean | null): ChatProjection {
  return {
    id: "chat-1",
    title: "A chat",
    parentId: null,
    createdAt: 1,
    updatedAt: 2,
    userId: "user-a",
    hostId: "host-1",
    isTitleEditedByUser: false,
    docResident,
    settings: null,
    archivedAt: null,
  };
}

/**
 * A host with a chat record plane but no terminal-agent remainder - the middle
 * of the three classes. Chats are complete on it (the registry's hydrate runs
 * `hydrateLegacyDocSecondary` unconditionally), so the chat arm is off.
 */
const RECORD_PLANE_CHATS_ONLY = { chats: false, tuiAgents: true } as const;

function route(
  docResident: boolean | null,
  docArm: { readonly chats: boolean; readonly tuiAgents: boolean },
): ChatWriteRoute {
  return routeChatWrite({ chat: chat(docResident), docArm });
}

describe("chat write routing - floor-era host (no record plane)", () => {
  it("ALLOWS every row, including a doc-projected one", () => {
    // `epic.renameChat` and friends are on the released floor and resolve a
    // pre-registry chat through the host's own storage seam. Gating here would
    // disable the affordance on a host that needs no gate - the regression that
    // made me back the first version of this out.
    expect(route(true, DOC_IS_THE_ONLY_RECORD_SOURCE)).toBe("registry-rpc");
    expect(route(null, DOC_IS_THE_ONLY_RECORD_SOURCE)).toBe("registry-rpc");
    expect(route(false, DOC_IS_THE_ONLY_RECORD_SOURCE)).toBe("registry-rpc");
  });

  it("ALLOWS a row the union does not hold at all", () => {
    expect(
      routeChatWrite({
        chat: undefined,
        docArm: DOC_IS_THE_ONLY_RECORD_SOURCE,
      }),
    ).toBe("registry-rpc");
  });
});

describe("chat write routing - host WITH a chat record plane", () => {
  it("ALLOWS a row the plane stated is store-homed", () => {
    expect(route(false, RECORD_PLANE_COVERS_BOTH)).toBe("registry-rpc");
    expect(route(false, RECORD_PLANE_CHATS_ONLY)).toBe("registry-rpc");
  });

  it("DISABLES a row the plane stated is doc-homed", () => {
    // Not a doc write: on a host with a record plane the doc is no longer the
    // authority, so record-wins would snap the edit back and the affordance
    // would read as working while changing nothing.
    expect(route(true, RECORD_PLANE_COVERS_BOTH)).toBe("unavailable");
  });

  it("DISABLES a row whose home the delivering plane never stated", () => {
    // `host.chatRecords.subscribe` carries the base row and the host announces
    // doc-homed chats on it (`hydrateLegacyDocSecondary(…, true)`), so `null` is
    // genuinely "could be either" - and a guess in the permissive direction
    // fails HOST-SIDE on the write, after the row rendered fine.
    expect(route(null, RECORD_PLANE_COVERS_BOTH)).toBe("unavailable");
  });

  it("DISABLES a row missing from the union", () => {
    expect(
      routeChatWrite({ chat: undefined, docArm: RECORD_PLANE_COVERS_BOTH }),
    ).toBe("unavailable");
  });

  it("re-enables the moment the home is STATED, with nothing else changing", () => {
    // The `null` window is one poll round trip wide, and closing it must not
    // require anything to remount or re-open: the same inputs but for the
    // stated home flip the verdict.
    const before = route(null, RECORD_PLANE_COVERS_BOTH);
    const after = route(false, RECORD_PLANE_COVERS_BOTH);
    expect(before).toBe("unavailable");
    expect(after).toBe("registry-rpc");
  });
});

describe("chat write routing - the terminal-agent arm is not consulted", () => {
  it("reads only the CHAT arm, so a TUI-only doc arm cannot open the chat gate", () => {
    // The two populations have different coverage conditions (the chat plane
    // has a hydration shim, the terminal plane does not), so a predicate that
    // read the wrong member would allow a doc-homed chat through on every host
    // serving `epic.listTuiAgents@1.0`.
    expect(route(true, RECORD_PLANE_CHATS_ONLY)).toBe("unavailable");
    expect(route(null, RECORD_PLANE_CHATS_ONLY)).toBe("unavailable");
  });
});
