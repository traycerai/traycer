import { describe, expect, it } from "vitest";
import {
  splitConnectionManifest,
  SERVES_EVERY_INSTALLED_MAJOR,
  upgradeResponseToVersion,
} from "@traycer/protocol/framework/index";
import { hostRpcRegistry } from "@traycer/protocol/host/index";
import { RELEASED_FLOOR_METHOD_NAMES } from "@traycer/protocol/host/released-floor";
import {
  deleteChatResponseSchema,
  deleteChatResponseSchemaV11,
  deleteTuiAgentResponseSchema,
  deleteTuiAgentResponseSchemaV10,
  setChatArchivedResponseSchema,
  setChatArchivedResponseSchemaV10,
} from "@traycer/protocol/host/epic/unary-schemas";
import {
  agentArchiveResponseSchema,
  agentArchiveResponseSchemaV10,
  agentArchiveUpgradeV10ToV11,
} from "@traycer/protocol/host/agent/archive";
import {
  epicDeleteChatUpgradeV11ToV12,
  epicDeleteTuiAgentUpgradeV10ToV11,
  epicSetChatArchivedUpgradeV10ToV11,
} from "@traycer/protocol/host/epic/contracts";

/**
 * `outcome` on the three agent-record writes (#1628): `applied` when the
 * receiving host enacted the change on its own record, `requested` when it is
 * not the owner and wrote the change to the cloud row instead. Each method gets
 * a NEW minor; the shipped minor below it is frozen so a released line never
 * grows, and a peer on that line (which has no non-owner branch) upgrades to
 * `applied`.
 */
describe("agent-record write outcome minors", () => {
  it("registers epic.deleteChat@1.2 above the frozen 1.0 and 1.1 lines", () => {
    const line = hostRpcRegistry["epic.deleteChat"][1];
    expect(line.latestMinor).toBe(2);
    expect(line.versions[1].contract.responseSchema).toBe(
      deleteChatResponseSchemaV11,
    );
    expect(line.versions[2].contract.responseSchema).toBe(
      deleteChatResponseSchema,
    );
    expect(line.downgradePathsFromLatest).toEqual({});
  });

  it("registers epic.setChatArchived@1.1 above the frozen 1.0 line", () => {
    const line = hostRpcRegistry["epic.setChatArchived"][1];
    expect(line.latestMinor).toBe(1);
    expect(line.versions[0].contract.responseSchema).toBe(
      setChatArchivedResponseSchemaV10,
    );
    expect(line.versions[1].contract.responseSchema).toBe(
      setChatArchivedResponseSchema,
    );
  });

  it("registers epic.deleteTuiAgent@1.1 above the frozen 1.0 line", () => {
    const line = hostRpcRegistry["epic.deleteTuiAgent"][1];
    expect(line.latestMinor).toBe(1);
    expect(line.versions[0].contract.responseSchema).toBe(
      deleteTuiAgentResponseSchemaV10,
    );
    expect(line.versions[1].contract.responseSchema).toBe(
      deleteTuiAgentResponseSchema,
    );
  });

  it("keeps epic.setChatArchived optional (off the floor) at its new minor", () => {
    expect(RELEASED_FLOOR_METHOD_NAMES).not.toContain("epic.setChatArchived");
    const split = splitConnectionManifest(
      hostRpcRegistry,
      RELEASED_FLOOR_METHOD_NAMES,
      SERVES_EVERY_INSTALLED_MAJOR,
    );
    expect(split.optionalManifest["epic.setChatArchived"]).toEqual({
      major: 1,
      minor: 1,
    });
    expect(hostRpcRegistry["epic.setChatArchived"].degrade).toEqual({
      kind: "unsupported",
    });
  });

  it("the frozen lines strip `outcome` - a released peer never sees it", () => {
    expect(
      deleteChatResponseSchemaV11.parse({
        deleted: true,
        publicationChatId: null,
        outcome: "requested",
      }),
    ).toEqual({ deleted: true, publicationChatId: null });
    expect(
      setChatArchivedResponseSchemaV10.parse({
        updated: true,
        outcome: "requested",
      }),
    ).toEqual({ updated: true });
    expect(
      deleteTuiAgentResponseSchemaV10.parse({
        deleted: true,
        outcome: "requested",
      }),
    ).toEqual({ deleted: true });
  });

  it("the live lines require `outcome` and accept only applied | requested", () => {
    expect(
      deleteChatResponseSchema.safeParse({
        deleted: true,
        publicationChatId: null,
      }).success,
    ).toBe(false);
    expect(
      setChatArchivedResponseSchema.safeParse({ updated: true }).success,
    ).toBe(false);
    expect(
      deleteTuiAgentResponseSchema.safeParse({ deleted: true }).success,
    ).toBe(false);
    expect(
      setChatArchivedResponseSchema.safeParse({
        updated: true,
        outcome: "pending",
      }).success,
    ).toBe(false);
    for (const outcome of ["applied", "requested"] as const) {
      expect(
        deleteChatResponseSchema.parse({
          deleted: true,
          publicationChatId: "clone-1",
          outcome,
        }).outcome,
      ).toBe(outcome);
      expect(
        setChatArchivedResponseSchema.parse({ updated: false, outcome })
          .outcome,
      ).toBe(outcome);
      expect(
        deleteTuiAgentResponseSchema.parse({ deleted: true, outcome }).outcome,
      ).toBe(outcome);
    }
  });

  it("the live lines carry the owner a `requested` answer was filed for, and accept its absence", () => {
    expect(
      deleteChatResponseSchema.parse({
        deleted: true,
        publicationChatId: null,
        outcome: "requested",
        ownerHostId: "host-b",
      }).ownerHostId,
    ).toBe("host-b");
    expect(
      setChatArchivedResponseSchema.parse({
        updated: true,
        outcome: "requested",
        ownerHostId: "host-b",
      }).ownerHostId,
    ).toBe("host-b");
    expect(
      deleteTuiAgentResponseSchema.parse({
        deleted: true,
        outcome: "requested",
        ownerHostId: "host-b",
      }).ownerHostId,
    ).toBe("host-b");
    expect(
      agentArchiveResponseSchema.parse({
        agentId: "agent-1",
        archived: true,
        updated: true,
        outcome: "requested",
        ownerHostId: "host-b",
      }).ownerHostId,
    ).toBe("host-b");
    // A peer that predates the field answers without it.
    expect(
      deleteChatResponseSchema.parse({
        deleted: true,
        publicationChatId: null,
        outcome: "requested",
      }).ownerHostId,
    ).toBeUndefined();
    expect(
      deleteChatResponseSchema.safeParse({
        deleted: true,
        publicationChatId: null,
        outcome: "requested",
        ownerHostId: "",
      }).success,
    ).toBe(false);
    // Each frozen predecessor line strips it, as it strips `outcome`.
    expect(
      deleteChatResponseSchemaV11.parse({
        deleted: true,
        publicationChatId: null,
        outcome: "requested",
        ownerHostId: "host-b",
      }),
    ).toEqual({ deleted: true, publicationChatId: null });
    expect(
      setChatArchivedResponseSchemaV10.parse({
        updated: true,
        outcome: "requested",
        ownerHostId: "host-b",
      }),
    ).toEqual({ updated: true });
    expect(
      deleteTuiAgentResponseSchemaV10.parse({
        deleted: true,
        outcome: "requested",
        ownerHostId: "host-b",
      }),
    ).toEqual({ deleted: true });
    expect(
      agentArchiveResponseSchemaV10.parse({
        agentId: "agent-1",
        archived: true,
        updated: true,
        outcome: "requested",
        ownerHostId: "host-b",
      }),
    ).toEqual({ agentId: "agent-1", archived: true, updated: true });
  });

  it("each upgrade path leaves the request alone and answers `applied`", () => {
    const deleteChatRequest = { epicId: "epic-1", chatId: "chat-1" };
    expect(
      epicDeleteChatUpgradeV11ToV12.upgradeRequest(deleteChatRequest),
    ).toBe(deleteChatRequest);
    expect(
      epicDeleteChatUpgradeV11ToV12.upgradeResponse({
        deleted: true,
        publicationChatId: "clone-1",
      }),
    ).toEqual({
      deleted: true,
      publicationChatId: "clone-1",
      outcome: "applied",
    });

    const archiveRequest = {
      epicId: "epic-1",
      chatId: "chat-1",
      archived: true,
    };
    expect(
      epicSetChatArchivedUpgradeV10ToV11.upgradeRequest(archiveRequest),
    ).toBe(archiveRequest);
    expect(
      epicSetChatArchivedUpgradeV10ToV11.upgradeResponse({ updated: true }),
    ).toEqual({ updated: true, outcome: "applied" });

    const tuiRequest = { epicId: "epic-1", tuiAgentId: "tui-1" };
    expect(epicDeleteTuiAgentUpgradeV10ToV11.upgradeRequest(tuiRequest)).toBe(
      tuiRequest,
    );
    expect(
      epicDeleteTuiAgentUpgradeV10ToV11.upgradeResponse({ deleted: false }),
    ).toEqual({ deleted: false, outcome: "applied" });
  });

  // Added during build (#1628 F7): the A2A archive tool dials this method on
  // the agent's host, and only that host knows whether it applied the archive
  // or, not running the agent, wrote it to the cloud row.
  it("registers agent.archive@1.1 above the frozen 1.0 line, still optional", () => {
    const line = hostRpcRegistry["agent.archive"][1];
    expect(line.latestMinor).toBe(1);
    expect(line.versions[0].contract.responseSchema).toBe(
      agentArchiveResponseSchemaV10,
    );
    expect(line.versions[1].contract.responseSchema).toBe(
      agentArchiveResponseSchema,
    );
    expect(line.downgradePathsFromLatest).toEqual({});
    expect(RELEASED_FLOOR_METHOD_NAMES).not.toContain("agent.archive");
    expect(hostRpcRegistry["agent.archive"].degrade).toEqual({
      kind: "unsupported",
    });
  });

  it("agent.archive: the frozen 1.0 strips `outcome`, the live line requires it, and 1.0 upgrades to `applied`", () => {
    const answer = { agentId: "agent-1", archived: true, updated: true };
    expect(
      agentArchiveResponseSchemaV10.parse({ ...answer, outcome: "requested" }),
    ).toEqual(answer);
    expect(agentArchiveResponseSchema.safeParse(answer).success).toBe(false);
    for (const outcome of ["applied", "requested"] as const) {
      expect(
        agentArchiveResponseSchema.parse({ ...answer, outcome }).outcome,
      ).toBe(outcome);
    }
    const request = {
      epicId: "epic-1",
      agentId: "agent-1",
      senderAgentId: "agent-0",
    };
    expect(agentArchiveUpgradeV10ToV11.upgradeRequest(request)).toBe(request);
    expect(
      upgradeResponseToVersion(
        hostRpcRegistry["agent.archive"],
        { major: 1, minor: 0 },
        { major: 1, minor: 1 },
        { agentId: "agent-1", archived: true, updated: false },
      ),
    ).toEqual({
      agentId: "agent-1",
      archived: true,
      updated: false,
      outcome: "applied",
    });
  });

  it("a 1.0 deleteChat answer chains through both upgrades to `applied` at 1.2", () => {
    const upgraded = upgradeResponseToVersion(
      hostRpcRegistry["epic.deleteChat"],
      { major: 1, minor: 0 },
      { major: 1, minor: 2 },
      { deleted: true },
    );
    expect(upgraded).toEqual({
      deleted: true,
      publicationChatId: null,
      outcome: "applied",
    });
  });
});
