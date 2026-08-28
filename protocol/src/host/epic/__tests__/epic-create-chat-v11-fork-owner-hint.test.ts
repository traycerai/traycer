import { describe, expect, it } from "vitest";
import {
  splitConnectionManifest,
  SERVES_EVERY_INSTALLED_MAJOR,
} from "@traycer/protocol/framework/index";
import { check } from "@traycer/protocol/framework/compatibility-checker";
import type { ConnectionManifest } from "@traycer/protocol/framework/ws-protocol";
import { hostRpcRegistry } from "@traycer/protocol/host/registry";
import { RELEASED_FLOOR_METHOD_NAMES } from "@traycer/protocol/host/released-floor";
import {
  epicCreateChatUpgradeV10ToV11,
  epicCreateChatV10,
  epicCreateChatV11,
} from "@traycer/protocol/host/epic/contracts";
import {
  createChatForkSourceAssistantBoundarySchema,
  createChatForkSourceLatestCheckpointBoundarySchema,
  createChatForkSourceSchemaV11,
  createChatRequestSchemaV11,
} from "@traycer/protocol/host/epic/unary-schemas";

/**
 * `epic.createChat@1.1` carries the `sourceOwnerUserId` fork-owner hint on its
 * PRECISE-boundary variant, not a separate `1.2`.
 *
 * The hint originally landed as a `1.2`, on the stated premise that
 * "`epic.createChat@1.1` is already in released hosts". That premise was
 * false: the newest released baseline (`host-v1.1.11`, commit c785d864)
 * reports `epic.createChat` at `latestMinor: 0` - confirmed against the tag's
 * own `registry.ts`, not just its published surface asset. Only `1.0` ever
 * shipped, so `1.1` was still free to grow and the extra minor bought nothing.
 *
 * `1.0` IS released, so the split between `createChatForkSourceSchema` (1.0's
 * untagged shape) and the tagged union below is real and stays.
 */

const manifestV10: ConnectionManifest = {
  "epic.createChat": { major: 1, minor: 0 },
};
const manifestV11: ConnectionManifest = {
  "epic.createChat": { major: 1, minor: 1 },
};

describe("epic.createChat stays on the released floor", () => {
  it("is present in RELEASED_FLOOR_METHOD_NAMES", () => {
    expect(RELEASED_FLOOR_METHOD_NAMES).toContain("epic.createChat");
  });

  it("advertises on the floor manifest at 1.1, not the optional manifest", () => {
    const split = splitConnectionManifest(
      hostRpcRegistry,
      RELEASED_FLOOR_METHOD_NAMES,
      SERVES_EVERY_INSTALLED_MAJOR,
    );
    expect(split.manifest["epic.createChat"]).toEqual({
      major: 1,
      minor: 1,
      supportedMajors: [1],
    });
    expect(split.optionalManifest["epic.createChat"]).toBeUndefined();
  });
});

describe("epic.createChat V11<->V10 negotiation bridges", () => {
  it("bridges a V11 host talking to a V10 peer, in both directions", () => {
    expect(check(hostRpcRegistry, manifestV11, manifestV10, "host")).toEqual({
      ok: true,
    });
    expect(check(hostRpcRegistry, manifestV11, manifestV10, "client")).toEqual({
      ok: true,
    });
    expect(check(hostRpcRegistry, manifestV10, manifestV11, "host")).toEqual({
      ok: true,
    });
    expect(check(hostRpcRegistry, manifestV10, manifestV11, "client")).toEqual({
      ok: true,
    });
  });
});

describe("epic.createChat registry line shape", () => {
  it("exposes minors 0 and 1 with latestMinor 1", () => {
    const line = hostRpcRegistry["epic.createChat"][1];
    expect(line.latestMinor).toBe(1);
    expect(Object.keys(line.versions).sort()).toEqual(["0", "1"]);
    expect(line.versions[0].contract).toBe(epicCreateChatV10);
    expect(line.versions[1].contract).toBe(epicCreateChatV11);
  });

  it("chains 1.0 -> 1.1 through epicCreateChatUpgradeV10ToV11", () => {
    const line = hostRpcRegistry["epic.createChat"][1];
    expect(line.versions[1].upgradeFromPreviousVersion).toBe(
      epicCreateChatUpgradeV10ToV11,
    );
    expect(line.versions[0].upgradeFromPreviousVersion).toBeNull();
  });
});

describe("createChatForkSourceAssistantBoundarySchema carries the owner hint", () => {
  const base = {
    boundary: "assistantMessage" as const,
    sourceChatId: "chat-1",
    assistantMessageId: "msg-1",
  };

  it("defaults sourceOwnerUserId to null when the field is absent", () => {
    const result = createChatForkSourceAssistantBoundarySchema.parse(base);
    expect(result.sourceOwnerUserId).toBeNull();
  });

  it("round-trips an explicit sourceOwnerUserId string", () => {
    const result = createChatForkSourceAssistantBoundarySchema.parse({
      ...base,
      sourceOwnerUserId: "user-42",
    });
    expect(result.sourceOwnerUserId).toBe("user-42");
  });

  it("rejects an empty-string sourceOwnerUserId", () => {
    const result = createChatForkSourceAssistantBoundarySchema.safeParse({
      ...base,
      sourceOwnerUserId: "",
    });
    expect(result.success).toBe(false);
  });

  it("accepts an explicit null sourceOwnerUserId", () => {
    const result = createChatForkSourceAssistantBoundarySchema.safeParse({
      ...base,
      sourceOwnerUserId: null,
    });
    expect(result.success).toBe(true);
  });

  it("still rejects a payload missing the required boundary fields", () => {
    const result = createChatForkSourceAssistantBoundarySchema.safeParse({
      boundary: "assistantMessage",
      sourceChatId: "chat-1",
    });
    expect(result.success).toBe(false);
  });
});

describe("the `latest` arm still requires sourceOwnerUserId explicitly", () => {
  const latest = {
    boundary: "latest" as const,
    sourceChatId: "chat-1",
    sourceOwnerUserId: "user-42",
  };

  it("parses when the field is present", () => {
    expect(
      createChatForkSourceLatestCheckpointBoundarySchema.safeParse(latest)
        .success,
    ).toBe(true);
  });

  it("FAILS when sourceOwnerUserId is omitted - it has no default", () => {
    const { sourceOwnerUserId: _omitted, ...withoutOwner } = latest;
    expect(
      createChatForkSourceLatestCheckpointBoundarySchema.safeParse(withoutOwner)
        .success,
    ).toBe(false);
  });

  it("createChatForkSourceSchemaV11 rejects a `latest` arm missing the field", () => {
    const { sourceOwnerUserId: _omitted, ...withoutOwner } = latest;
    expect(createChatForkSourceSchemaV11.safeParse(withoutOwner).success).toBe(
      false,
    );
  });

  it("createChatForkSourceSchemaV11 accepts a well-formed `latest` arm", () => {
    expect(createChatForkSourceSchemaV11.safeParse(latest).success).toBe(true);
  });
});

describe("epicCreateChatUpgradeV10ToV11.upgradeRequest", () => {
  const v10Request = {
    epicId: "epic-1",
    parentId: null,
    hostId: "host-1",
    title: "t",
    chatId: "chat-new",
  };

  it("tags a v1.0 precise-boundary forkSource and defaults the owner hint", () => {
    const upgraded = epicCreateChatUpgradeV10ToV11.upgradeRequest({
      ...v10Request,
      forkSource: {
        sourceChatId: "chat-1",
        assistantMessageId: "msg-1",
      },
    });
    const parsed = createChatRequestSchemaV11.parse(upgraded);
    expect(parsed.forkSource).toMatchObject({
      boundary: "assistantMessage",
      sourceChatId: "chat-1",
      assistantMessageId: "msg-1",
      sourceOwnerUserId: null,
    });
  });

  it("leaves a null forkSource alone", () => {
    const upgraded = epicCreateChatUpgradeV10ToV11.upgradeRequest({
      ...v10Request,
      forkSource: null,
    });
    expect(upgraded.forkSource).toBeNull();
    expect(createChatRequestSchemaV11.safeParse(upgraded).success).toBe(true);
  });

  it("leaves an absent (undefined) forkSource alone", () => {
    const upgraded = epicCreateChatUpgradeV10ToV11.upgradeRequest(v10Request);
    expect(upgraded.forkSource).toBeUndefined();
    expect(createChatRequestSchemaV11.safeParse(upgraded).success).toBe(true);
  });

  it("upgradeResponse is response identity", () => {
    const response = { chatId: "chat-new" };
    expect(epicCreateChatUpgradeV10ToV11.upgradeResponse(response)).toBe(
      response,
    );
  });
});
