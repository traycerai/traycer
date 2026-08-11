import { describe, expect, it } from "vitest";
import type { AssembledChat } from "@traycer/protocol/persistence/chat-sync/assembly";
import { CAPTURED_RESIDUAL_LEVELS } from "@traycer/protocol/persistence/chat-sync/captured-levels";
import {
  describeUnknownVariant,
  presentChat,
  NO_PAYLOADS_RESOLVABLE,
} from "@traycer/protocol/persistence/chat-sync/presentation";
import {
  serializeChatShard,
  type ChatShardRecord,
} from "@traycer/protocol/persistence/chat-sync/shard";
import {
  webCryptoSha256Hex,
  utf8Bytes,
  utf8Text,
} from "@traycer-clients/shared/cloud-chat/bytes";
import { readCloudChat } from "@traycer-clients/shared/cloud-chat/cloud-chat-reader";
import {
  buildChatCloneSeed,
  carriedCloneResiduals,
  chatCloneResidualsOf,
} from "@traycer-clients/shared/cloud-chat/clone";
import { InMemoryChatPartCache } from "@traycer-clients/shared/cloud-chat/part-cache";
import { resolverFromPayloadRefs } from "@traycer-clients/shared/cloud-chat/payloads";
import {
  DEFAULT_PUBLISH,
  FIRST_COHORT,
  FUTURE_FIELDS,
  IDENTITY,
  publishCloudChat,
  recordingPort,
  servingBehaviour,
  type PublishOptions,
  type PublishedCloudChat,
} from "./__fixtures__/published-cloud-chat";

/**
 * What a reader does with an assembled chat: renders it, and clones it.
 *
 * The through-line of this suite is the passthrough, end to end. A block type
 * from a newer writer has to survive four hops - the shard's parse, assembly,
 * presentation, and a clone's re-publication - and it is the LAST one that
 * matters, because the first three failing is loud and the fourth failing is
 * silent data loss discovered by whoever opens the clone.
 */

async function readPublished(options: PublishOptions): Promise<{
  readonly published: PublishedCloudChat;
  readonly chat: AssembledChat;
}> {
  const published = await publishCloudChat(options);
  const result = await readCloudChat({
    identity: IDENTITY,
    port: recordingPort(servingBehaviour(published)),
    cache: new InMemoryChatPartCache(),
    sha256Hex: webCryptoSha256Hex,
  });
  if (result.outcome.kind !== "ok") {
    throw new Error(`Fixture chat did not read: ${result.outcome.kind}`);
  }
  return { published, chat: result.outcome.chat };
}

describe("an unknown block type", () => {
  it("presents as an unknown marker rather than vanishing", async () => {
    const { chat } = await readPublished(DEFAULT_PUBLISH);

    const presented = presentChat(chat, {
      resolvePayload: NO_PAYLOADS_RESOLVABLE,
    });
    const assistant = presented.messages[1];
    const future = assistant.blocks.find(
      (block) => block.variant === "holodeck",
    );

    // Present, not dropped: a dropped block is indistinguishable from a chat
    // that never had one.
    expect(future).toBeDefined();
    if (future === undefined) return;
    expect(future.known).toBeNull();
    expect(future.raw.program).toEqual({
      name: "cafe",
      characters: ["leah", null, 3],
    });
    expect(presented.fidelity.unknownBlocks).toBe(1);
    expect(describeUnknownVariant("block", future.variant)).toContain(
      "holodeck",
    );
  });

  it("survives a clone's re-publication BYTE-IDENTICALLY", async () => {
    const { published, chat } = await readPublished(DEFAULT_PUBLISH);

    const clone = buildChatCloneSeed({
      chat,
      sourceHeadSha256: published.headSha256,
      newChatId: "chat-clone",
      ownerUserId: "u-2",
      originHostId: "host-target",
      parentChatId: null,
      createdAt: 9_000,
    });
    expect(clone.status).toBe("ok");
    if (clone.status !== "ok") return;

    // Re-shard the cloned messages under the SOURCE's identity and re-serialize.
    // Under the clone's own id the bytes would differ by exactly `chatId`, which
    // proves nothing about the payload; holding identity fixed makes the
    // comparison a statement about the transcript alone.
    const rebuilt: ChatShardRecord = {
      schemaVersion: chat.schemaVersion,
      chatId: chat.core.chatId,
      section: "messages",
      messages: [...clone.seed.messages.slice(0, FIRST_COHORT.length)],
      events: [],
      hostPrivate: null,
      residual: {},
    };

    expect(serializeChatShard(rebuilt)).toBe(
      utf8Text(published.parts[0].bytes),
    );
  });
});

describe("residual lifting", () => {
  it("carries every captured level a clone can carry", async () => {
    const { published, chat } = await readPublished({
      ...DEFAULT_PUBLISH,
      withFutureFields: true,
    });

    const clone = buildChatCloneSeed({
      chat,
      sourceHeadSha256: published.headSha256,
      newChatId: "chat-clone",
      ownerUserId: "u-2",
      originHostId: "host-target",
      parentChatId: null,
      createdAt: 9_000,
    });
    expect(clone.status).toBe("ok");
    if (clone.status !== "ok") return;

    const carried = carriedCloneResiduals(clone.seed.residuals);
    expect(carried.head).toEqual({ [FUTURE_FIELDS.head]: "head-level" });
    expect(carried.core).toEqual({ [FUTURE_FIELDS.core]: "core-level" });
    expect(carried["core.lifecycle"]).toEqual({
      [FUTURE_FIELDS["core.lifecycle"]]: "lifecycle-level",
    });
    expect(carried["core.settings"]).toEqual({
      [FUTURE_FIELDS["core.settings"]]: "settings-level",
    });
  });

  it("drops hostPrivate and SAYS SO rather than dropping it silently", async () => {
    const { published, chat } = await readPublished({
      ...DEFAULT_PUBLISH,
      withFutureFields: true,
    });

    const clone = buildChatCloneSeed({
      chat,
      sourceHeadSha256: published.headSha256,
      newChatId: "chat-clone",
      ownerUserId: "u-2",
      originHostId: "host-target",
      parentChatId: null,
      createdAt: 9_000,
    });
    if (clone.status !== "ok") throw new Error("expected a clone");

    expect(clone.seed.residuals.hostPrivate.kind).toBe("dropped");
    expect(
      carriedCloneResiduals(clone.seed.residuals).hostPrivate,
    ).toBeUndefined();
    expect(clone.seed.unpreservedKeys).toEqual([
      `hostPrivate.${FUTURE_FIELDS.hostPrivate}`,
    ]);
  });

  it("accounts for EVERY level the protocol declares", async () => {
    const { chat } = await readPublished(DEFAULT_PUBLISH);
    const residuals = chatCloneResidualsOf(chat);

    // The completeness guard, consumed across the package boundary: a level
    // added by a minor and not decided on here fails at compile time via the
    // exhaustive Record, and fails here if the manifest and the table drift for
    // any other reason.
    expect(Object.keys(residuals).sort()).toEqual(
      CAPTURED_RESIDUAL_LEVELS.map((level) => level.id).sort(),
    );
  });
});

describe("what a clone is", () => {
  it("mints a new identity and keeps the source only as provenance", async () => {
    const { published, chat } = await readPublished(DEFAULT_PUBLISH);

    const clone = buildChatCloneSeed({
      chat,
      sourceHeadSha256: published.headSha256,
      newChatId: "chat-clone",
      ownerUserId: "u-2",
      originHostId: "host-target",
      parentChatId: "local-parent",
      createdAt: 9_000,
    });
    if (clone.status !== "ok") throw new Error("expected a clone");

    expect(clone.seed.core.chatId).toBe("chat-clone");
    expect(clone.seed.core.ownerUserId).toBe("u-2");
    // The clone's origin is HERE. Carrying the source's would point a live chat
    // at a host that does not own it.
    expect(clone.seed.core.originHostId).toBe("host-target");
    // Never inherited: a source parent id names a chat in the source host's
    // registry and generally does not exist here.
    expect(clone.seed.core.parentChatId).toBe("local-parent");
    expect(clone.seed.core.title).toBe(chat.core.title);
    expect(clone.seed.provenance).toEqual({
      sourceChatId: chat.core.chatId,
      sourceOwnerUserId: chat.core.ownerUserId,
      sourceOriginHostId: chat.core.originHostId,
      sourceHeadSha256: published.headSha256,
      sourceThroughRecordSeq: chat.throughRecordSeq,
    });
  });

  it("carries an archived lifecycle verbatim, bag and all", async () => {
    const { published, chat } = await readPublished({
      ...DEFAULT_PUBLISH,
      withFutureFields: true,
      lifecycleState: "archived",
    });

    const clone = buildChatCloneSeed({
      chat,
      sourceHeadSha256: published.headSha256,
      newChatId: "chat-clone",
      ownerUserId: "u-2",
      originHostId: "host-target",
      parentChatId: null,
      createdAt: 9_000,
    });
    if (clone.status !== "ok") throw new Error("expected a clone");

    // Verbatim rather than reset, so the level's declared fields and its
    // residual bag cannot end up describing two different lifecycles.
    expect(clone.seed.core.lifecycle.state).toBe("archived");
    expect(clone.seed.core.lifecycle.archivedAt).toBe(6);
    expect(clone.seed.core.lifecycle.residual).toEqual({
      [FUTURE_FIELDS["core.lifecycle"]]: "lifecycle-level",
    });
  });

  it("refuses a deleted source instead of resurrecting it", async () => {
    const { published, chat } = await readPublished({
      ...DEFAULT_PUBLISH,
      lifecycleState: "deleted",
    });

    const clone = buildChatCloneSeed({
      chat,
      sourceHeadSha256: published.headSha256,
      newChatId: "chat-clone",
      ownerUserId: "u-2",
      originHostId: "host-target",
      parentChatId: null,
      createdAt: 9_000,
    });

    expect(clone.status).toBe("refused");
    if (clone.status !== "refused") return;
    expect(clone.reason).toBe("source-deleted");
  });
});

describe("payload markers", () => {
  it("marks refs the cloud cannot serve as MISSING, and counts them", async () => {
    const { chat } = await readPublished(DEFAULT_PUBLISH);

    const presented = presentChat(chat, {
      resolvePayload: resolverFromPayloadRefs([]),
    });

    // The fixture's `file_change` block names two blob hashes; neither was
    // published, so both are gaps the transcript must state rather than render
    // as a chat with no diff.
    expect(presented.fidelity.missingPayloads).toBe(2);
  });

  it("marks a ref the cloud DOES hold as resolvable", async () => {
    const { chat } = await readPublished(DEFAULT_PUBLISH);

    const presented = presentChat(chat, {
      resolvePayload: resolverFromPayloadRefs([
        { kind: "file-snapshot", sha256: "aaa111" },
      ]),
    });

    expect(presented.fidelity.missingPayloads).toBe(1);
    const fileBlock = presented.messages[1].blocks.find(
      (block) => block.variant === "file_change",
    );
    expect(fileBlock?.payloadRefs.map((ref) => ref.availability)).toEqual([
      "resolvable",
      "missing",
    ]);
  });
});

describe("the digest identity", () => {
  it("the head document's own digest is what the row carries", async () => {
    const published = await publishCloudChat(DEFAULT_PUBLISH);
    expect(await webCryptoSha256Hex(utf8Bytes(published.headDocument))).toBe(
      published.headSha256,
    );
    expect(published.summary.headSha256).toBe(published.headSha256);
  });
});
