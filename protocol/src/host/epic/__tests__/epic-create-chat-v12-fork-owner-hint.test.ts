import { describe, expect, it } from "vitest";
import { splitConnectionManifest } from "@traycer/protocol/framework/index";
import { check } from "@traycer/protocol/framework/compatibility-checker";
import type { ConnectionManifest } from "@traycer/protocol/framework/ws-protocol";
import { hostRpcRegistry } from "@traycer/protocol/host/registry";
import { RELEASED_FLOOR_METHOD_NAMES } from "@traycer/protocol/host/released-floor";
import {
  epicCreateChatUpgradeV11ToV12,
  epicCreateChatV10,
  epicCreateChatV11,
  epicCreateChatV12,
} from "@traycer/protocol/host/epic/contracts";
import {
  createChatForkSourceAssistantBoundarySchema,
  createChatForkSourceAssistantBoundarySchemaV12,
  createChatForkSourceLatestCheckpointBoundarySchema,
  createChatForkSourceSchemaV12,
  createChatRequestSchemaV11,
  createChatRequestSchemaV12,
} from "@traycer/protocol/host/epic/unary-schemas";

const manifestV10: ConnectionManifest = {
  "epic.createChat": { major: 1, minor: 0 },
};
const manifestV11: ConnectionManifest = {
  "epic.createChat": { major: 1, minor: 1 },
};
const manifestV12: ConnectionManifest = {
  "epic.createChat": { major: 1, minor: 2 },
};

// ─── A. V11<->V12 negotiation fixtures ───────────────────────────────────────

describe("epic.createChat@1.2 stays on the released floor", () => {
  it("is present in RELEASED_FLOOR_METHOD_NAMES", () => {
    expect(RELEASED_FLOOR_METHOD_NAMES).toContain("epic.createChat");
  });

  it("advertises on the floor manifest at 1.2, not the optional manifest", () => {
    const split = splitConnectionManifest(
      hostRpcRegistry,
      RELEASED_FLOOR_METHOD_NAMES,
    );
    expect(split.manifest["epic.createChat"]).toEqual({ major: 1, minor: 2 });
    expect(split.optionalManifest["epic.createChat"]).toBeUndefined();
  });
});

describe("epic.createChat V12<->V11 and V12<->V10 negotiation bridges", () => {
  it("bridges a V12 host talking to a V11 peer, in both directions", () => {
    // The newer side (V12) bridges because minor 1 is still installed in its
    // own registry line - `hostRpcRegistry` carries minors 0, 1 and 2 for
    // `epic.createChat`, so `check()` finds the older peer's minor present
    // in the within-major chain.
    const newerAsHost = check(
      hostRpcRegistry,
      manifestV12,
      manifestV11,
      "host",
    );
    expect(newerAsHost).toEqual({ ok: true });

    const newerAsClient = check(
      hostRpcRegistry,
      manifestV12,
      manifestV11,
      "client",
    );
    expect(newerAsClient).toEqual({ ok: true });

    // The older side (V11) never transforms; it just accepts the peer being
    // ahead on the same major.
    const olderAsHost = check(
      hostRpcRegistry,
      manifestV11,
      manifestV12,
      "host",
    );
    expect(olderAsHost).toEqual({ ok: true });

    const olderAsClient = check(
      hostRpcRegistry,
      manifestV11,
      manifestV12,
      "client",
    );
    expect(olderAsClient).toEqual({ ok: true });
  });

  it("bridges a V12 host talking to a V10 peer, in both directions", () => {
    const newerAsHost = check(
      hostRpcRegistry,
      manifestV12,
      manifestV10,
      "host",
    );
    expect(newerAsHost).toEqual({ ok: true });

    const newerAsClient = check(
      hostRpcRegistry,
      manifestV12,
      manifestV10,
      "client",
    );
    expect(newerAsClient).toEqual({ ok: true });

    const olderAsHost = check(
      hostRpcRegistry,
      manifestV10,
      manifestV12,
      "host",
    );
    expect(olderAsHost).toEqual({ ok: true });

    const olderAsClient = check(
      hostRpcRegistry,
      manifestV10,
      manifestV12,
      "client",
    );
    expect(olderAsClient).toEqual({ ok: true });
  });
});

describe("epic.createChat registry line shape", () => {
  it("exposes minors 0, 1, 2 with latestMinor 2", () => {
    const line = hostRpcRegistry["epic.createChat"][1];
    expect(line.latestMinor).toBe(2);
    expect(Object.keys(line.versions).sort()).toEqual(["0", "1", "2"]);
    expect(line.versions[0].contract).toBe(epicCreateChatV10);
    expect(line.versions[1].contract).toBe(epicCreateChatV11);
    expect(line.versions[2].contract).toBe(epicCreateChatV12);
  });

  it("chains 1.1 -> 1.2 through epicCreateChatUpgradeV11ToV12", () => {
    const line = hostRpcRegistry["epic.createChat"][1];
    expect(line.versions[2].upgradeFromPreviousVersion).toBe(
      epicCreateChatUpgradeV11ToV12,
    );
  });
});

describe("downgrading V12 -> V11 silently strips sourceOwnerUserId (documented, not a bug)", () => {
  // This is the EXPECTED behavior at the schema layer: `createChatRequestSchemaV11`
  // has no knowledge of `sourceOwnerUserId`, so parsing a V12-shaped payload
  // with it strips the field via ordinary Zod object parsing (unknown keys are
  // dropped, not rejected). The client-side gate that stops a caller from
  // DEPENDING on a stripped hint (i.e. never assuming the hint survived a
  // downgrade) belongs to a different ticket (A2/A4) - this test only pins the
  // strip itself as intentional protocol-layer behavior.
  it("strips sourceOwnerUserId when a V12 fork-source payload is parsed by the V11 request schema", () => {
    const v12Request = {
      epicId: "epic-1",
      parentId: null,
      hostId: "host-1",
      title: "Forked chat",
      chatId: "chat-2",
      forkSource: {
        boundary: "assistantMessage" as const,
        sourceChatId: "chat-1",
        assistantMessageId: "msg-1",
        interviewBlockId: null,
        carriedInterviews: null,
        sourceOwnerUserId: "user-1",
      },
    };

    const parsed = createChatRequestSchemaV11.parse(v12Request);
    expect(parsed.forkSource).toEqual({
      boundary: "assistantMessage",
      sourceChatId: "chat-1",
      assistantMessageId: "msg-1",
      interviewBlockId: null,
      carriedInterviews: null,
    });
    expect(
      Object.hasOwn(
        parsed.forkSource as Record<string, unknown>,
        "sourceOwnerUserId",
      ),
    ).toBe(false);
  });
});

// ─── B. Schema round-trip for the widened variant ────────────────────────────

describe("createChatForkSourceAssistantBoundarySchemaV12", () => {
  const base = {
    boundary: "assistantMessage" as const,
    sourceChatId: "chat-1",
    assistantMessageId: "msg-1",
  };

  it("defaults sourceOwnerUserId to null when the field is absent", () => {
    const result = createChatForkSourceAssistantBoundarySchemaV12.parse(base);
    expect(result.sourceOwnerUserId).toBeNull();
  });

  it("round-trips an explicit sourceOwnerUserId string", () => {
    const result = createChatForkSourceAssistantBoundarySchemaV12.parse({
      ...base,
      sourceOwnerUserId: "user-42",
    });
    expect(result.sourceOwnerUserId).toBe("user-42");
  });

  it("rejects an empty-string sourceOwnerUserId", () => {
    const result = createChatForkSourceAssistantBoundarySchemaV12.safeParse({
      ...base,
      sourceOwnerUserId: "",
    });
    expect(result.success).toBe(false);
  });

  it("accepts an explicit null sourceOwnerUserId", () => {
    const result = createChatForkSourceAssistantBoundarySchemaV12.parse({
      ...base,
      sourceOwnerUserId: null,
    });
    expect(result.sourceOwnerUserId).toBeNull();
  });
});

describe("the `latest` arm at V12 still requires sourceOwnerUserId explicitly", () => {
  // Ticket 37 already made `sourceOwnerUserId` a required-nullable (no
  // default) on the `latest` boundary variant, and V12 does not touch that
  // arm at all - it is reused byte-identical from V11. Asserted here rather
  // than papered over: unlike the `assistantMessage` arm's V12 default, a
  // `latest` payload that OMITS the field still fails to parse.
  it("still parses when the field is present (unchanged from v1.1)", () => {
    const result = createChatForkSourceLatestCheckpointBoundarySchema.parse({
      boundary: "latest",
      sourceChatId: "chat-1",
      sourceOwnerUserId: "user-1",
    });
    expect(result.sourceOwnerUserId).toBe("user-1");

    const withNull = createChatForkSourceLatestCheckpointBoundarySchema.parse({
      boundary: "latest",
      sourceChatId: "chat-1",
      sourceOwnerUserId: null,
    });
    expect(withNull.sourceOwnerUserId).toBeNull();
  });

  it("still FAILS when sourceOwnerUserId is omitted, at V12 same as V11", () => {
    const result = createChatForkSourceLatestCheckpointBoundarySchema.safeParse(
      {
        boundary: "latest",
        sourceChatId: "chat-1",
      },
    );
    expect(result.success).toBe(false);
  });

  it("createChatForkSourceSchemaV12 rejects a `latest` arm missing the field", () => {
    const result = createChatForkSourceSchemaV12.safeParse({
      boundary: "latest",
      sourceChatId: "chat-1",
    });
    expect(result.success).toBe(false);
  });

  it("createChatForkSourceSchemaV12 accepts a well-formed `latest` arm", () => {
    const result = createChatForkSourceSchemaV12.safeParse({
      boundary: "latest",
      sourceChatId: "chat-1",
      sourceOwnerUserId: null,
    });
    expect(result.success).toBe(true);
  });
});

describe("epicCreateChatUpgradeV11ToV12.upgradeRequest", () => {
  const baseRequest = {
    epicId: "epic-1",
    parentId: null,
    hostId: "host-1",
    title: "Forked chat",
    chatId: "chat-2",
  };

  it("fills sourceOwnerUserId: null on a V11 precise-boundary forkSource", () => {
    const v11Request = {
      ...baseRequest,
      forkSource: {
        boundary: "assistantMessage" as const,
        sourceChatId: "chat-1",
        assistantMessageId: "msg-1",
        interviewBlockId: null,
        carriedInterviews: null,
      },
    };

    const upgraded = epicCreateChatUpgradeV11ToV12.upgradeRequest(v11Request);
    expect(upgraded.forkSource).toEqual({
      boundary: "assistantMessage",
      sourceChatId: "chat-1",
      assistantMessageId: "msg-1",
      interviewBlockId: null,
      carriedInterviews: null,
      sourceOwnerUserId: null,
    });
    expect(createChatRequestSchemaV12.safeParse(upgraded).success).toBe(true);
  });

  it("passes a `latest` forkSource through unchanged", () => {
    const v11Request = {
      ...baseRequest,
      forkSource: {
        boundary: "latest" as const,
        sourceChatId: "chat-1",
        sourceOwnerUserId: "user-9",
      },
    };

    const upgraded = epicCreateChatUpgradeV11ToV12.upgradeRequest(v11Request);
    expect(upgraded.forkSource).toEqual(v11Request.forkSource);
    expect(createChatRequestSchemaV12.safeParse(upgraded).success).toBe(true);
  });

  it("leaves a null forkSource alone", () => {
    const v11Request = { ...baseRequest, forkSource: null };
    const upgraded = epicCreateChatUpgradeV11ToV12.upgradeRequest(v11Request);
    expect(upgraded.forkSource).toBeNull();
    expect(createChatRequestSchemaV12.safeParse(upgraded).success).toBe(true);
  });

  it("leaves an absent (undefined) forkSource alone", () => {
    const v11Request = { ...baseRequest, forkSource: undefined };
    const upgraded = epicCreateChatUpgradeV11ToV12.upgradeRequest(v11Request);
    expect(upgraded.forkSource).toBeUndefined();
    expect(createChatRequestSchemaV12.safeParse(upgraded).success).toBe(true);
  });

  it("every upgraded output parses cleanly against createChatRequestSchemaV12", () => {
    for (const forkSource of [
      null,
      undefined,
      {
        boundary: "assistantMessage" as const,
        sourceChatId: "chat-1",
        assistantMessageId: "msg-1",
        interviewBlockId: "block-1",
        carriedInterviews: "settled" as const,
      },
      {
        boundary: "latest" as const,
        sourceChatId: "chat-1",
        sourceOwnerUserId: null,
      },
    ]) {
      const v11Request = createChatRequestSchemaV11.parse({
        ...baseRequest,
        forkSource,
      });
      const upgraded = epicCreateChatUpgradeV11ToV12.upgradeRequest(v11Request);
      expect(createChatRequestSchemaV12.safeParse(upgraded).success).toBe(true);
    }
  });

  it("upgradeResponse is response identity", () => {
    const response = { chatId: "chat-2", initialTurnStarted: true };
    expect(epicCreateChatUpgradeV11ToV12.upgradeResponse(response)).toEqual(
      response,
    );
  });
});

describe("createChatForkSourceAssistantBoundarySchema (v1.1's frozen shape) is unchanged", () => {
  it("still accepts every field it accepted before", () => {
    const result = createChatForkSourceAssistantBoundarySchema.safeParse({
      boundary: "assistantMessage",
      sourceChatId: "chat-1",
      assistantMessageId: "msg-1",
      interviewBlockId: "block-1",
      carriedInterviews: "pending",
    });
    expect(result.success).toBe(true);
  });

  it("still strips an unknown sourceOwnerUserId field (frozen shape, no new field)", () => {
    const result = createChatForkSourceAssistantBoundarySchema.parse({
      boundary: "assistantMessage",
      sourceChatId: "chat-1",
      assistantMessageId: "msg-1",
      sourceOwnerUserId: "user-1",
    });
    expect(
      Object.hasOwn(result as Record<string, unknown>, "sourceOwnerUserId"),
    ).toBe(false);
  });

  it("still rejects nothing it rejected before (missing required fields)", () => {
    const result = createChatForkSourceAssistantBoundarySchema.safeParse({
      boundary: "assistantMessage",
      sourceChatId: "chat-1",
      // assistantMessageId missing
    });
    expect(result.success).toBe(false);
  });
});
