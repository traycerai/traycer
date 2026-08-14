import { describe, expect, it } from "vitest";
import {
  encodeBase64,
  utf8Bytes,
  webCryptoSha256Hex,
} from "@traycer-clients/shared/cloud-chat/bytes";
import {
  readCloudChat,
  type CloudChatRead,
} from "@traycer-clients/shared/cloud-chat/cloud-chat-reader";
import {
  InMemoryChatPartCache,
  NO_PART_CACHE,
  type ChatPartCache,
} from "@traycer-clients/shared/cloud-chat/part-cache";
import {
  DEFAULT_PUBLISH,
  FIRST_COHORT,
  IDENTITY,
  SECOND_COHORT,
  UNPUBLISHED_SUMMARY,
  assistantMessage,
  publishCloudChat,
  recordingPort,
  servingBehaviour,
  textBlock,
  userMessage,
  withForgedPartsEnvelope,
  type PublishedCloudChat,
  type RecordingPort,
} from "./__fixtures__/published-cloud-chat";

/**
 * The client read path, asserted where its promises actually live.
 *
 * Every incremental claim here is a CALL COUNT on the port, never a property of
 * what was returned. That distinction is the whole point of the suite: a reader
 * that ignored its cache and refetched every part still produces a byte-identical
 * transcript, so an assertion on the assembled chat cannot tell the incremental
 * read from the whole one. Only `port.partCalls` can.
 */

function read(
  port: RecordingPort,
  cache: ChatPartCache,
): Promise<CloudChatRead> {
  return readCloudChat({
    identity: IDENTITY,
    port,
    cache,
    sha256Hex: webCryptoSha256Hex,
  });
}

/**
 * The same bytes with one bit changed - same length, different content.
 *
 * The mutation every hash-guard test here uses. A wrong-LENGTH corruption is
 * caught by the length check on its own, so it cannot witness whether anything
 * hashes; only an equal-length one can.
 */
function flipOneByte(bytes: Uint8Array): Uint8Array {
  const mutated = new Uint8Array(bytes);
  mutated[0] ^= 0x01;
  return mutated;
}

/** The fixture chat with one more message appended to its TAIL cohort. */
function publishOneMoreTurn(): Promise<PublishedCloudChat> {
  return publishCloudChat({
    ...DEFAULT_PUBLISH,
    cohorts: [
      FIRST_COHORT,
      [
        ...SECOND_COHORT,
        userMessage("m-user-3"),
        assistantMessage("m-assistant-3", [textBlock("b-text-3", "one more")]),
      ],
    ],
  });
}

describe("cold read", () => {
  it("fetches the head and every part exactly once", async () => {
    const published = await publishCloudChat(DEFAULT_PUBLISH);
    const port = recordingPort(servingBehaviour(published));

    const result = await read(port, new InMemoryChatPartCache());

    expect(result.outcome.kind).toBe("ok");
    expect(port.resolveCalls).toHaveLength(1);
    expect(port.partCalls).toEqual(
      published.parts.map((part) => part.address.sha256),
    );
  });

  it("assembles messages in HEAD order, not completion order", async () => {
    const published = await publishCloudChat(DEFAULT_PUBLISH);
    const serving = servingBehaviour(published);
    const firstCohort = published.parts[0].address.sha256;
    // The tail cohort settles first and the head cohort last, so completion
    // order is the exact reverse of head order. Without the sort in
    // `assembleChat`, this is the test that goes red.
    const port = recordingPort({
      resolve: serving.resolve,
      part: async (sha256) => {
        if (sha256 === firstCohort) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        return serving.part(sha256);
      },
    });

    const result = await read(port, new InMemoryChatPartCache());

    expect(result.outcome.kind).toBe("ok");
    if (result.outcome.kind !== "ok") return;
    expect(
      result.outcome.chat.messages.map((message) => message.raw.messageId),
    ).toEqual(["m-user", "m-assistant", "m-user-2", "m-assistant-2"]);
  });
});

describe("the incremental read", () => {
  it("reopening after one new turn fetches the head and the TAIL SHARD ONLY", async () => {
    const cache = new InMemoryChatPartCache();

    const first = await publishCloudChat(DEFAULT_PUBLISH);
    const firstPort = recordingPort(servingBehaviour(first));
    expect((await read(firstPort, cache)).outcome.kind).toBe("ok");
    expect(firstPort.partCalls).toHaveLength(first.parts.length);

    const second = await publishOneMoreTurn();
    const secondPort = recordingPort(servingBehaviour(second));
    const result = await read(secondPort, cache);

    expect(result.outcome.kind).toBe("ok");
    // The head is always re-read - it is the thing that changed. Exactly one
    // part is fetched, and it is the tail cohort whose contents actually moved.
    expect(secondPort.resolveCalls).toHaveLength(1);
    expect(secondPort.partCalls).toEqual([second.parts[1].address.sha256]);
    // ...and the head cohort's address is untouched, which is why it was not
    // fetched: a deterministic re-cut of an unchanged prefix produces the same
    // cohort, so the same bytes, so the same address.
    expect(second.parts[0].address.sha256).toBe(first.parts[0].address.sha256);
  });

  it("reopening an UNCHANGED chat fetches no parts at all", async () => {
    const cache = new InMemoryChatPartCache();
    const published = await publishCloudChat(DEFAULT_PUBLISH);

    expect(
      (await read(recordingPort(servingBehaviour(published)), cache)).outcome
        .kind,
    ).toBe("ok");

    const reopen = recordingPort(servingBehaviour(published));
    expect((await read(reopen, cache)).outcome.kind).toBe("ok");
    expect(reopen.partCalls).toEqual([]);
  });

  // The ablation: without a cache the SAME sequence refetches everything. If
  // this passed too, the assertions above would be measuring something other
  // than the cache.
  it("ABLATION - with no cache, reopening refetches every part", async () => {
    const first = await publishCloudChat(DEFAULT_PUBLISH);
    expect(
      (await read(recordingPort(servingBehaviour(first)), NO_PART_CACHE))
        .outcome.kind,
    ).toBe("ok");

    const second = await publishOneMoreTurn();
    const secondPort = recordingPort(servingBehaviour(second));
    await read(secondPort, NO_PART_CACHE);

    expect(secondPort.partCalls).toHaveLength(second.parts.length);
  });

  it("a cache hit is re-hashed, so a poisoned entry is refetched not trusted", async () => {
    const published = await publishCloudChat(DEFAULT_PUBLISH);
    const cache = new InMemoryChatPartCache();
    // A SAME-LENGTH mutation, which is the only shape that tests what this
    // claims to. Bytes of the wrong length are caught by the length guard
    // whether or not anything re-hashes, so a wrong-length fixture here would
    // stay green with the hash check deleted - a test that witnesses nothing.
    await cache.put(
      published.parts[0].address.sha256,
      flipOneByte(published.parts[0].bytes),
    );

    const port = recordingPort(servingBehaviour(published));
    const result = await read(port, cache);

    // Not trusted, and not fatal either: a store that answers with the wrong
    // bytes is a MISS, so the read falls through to the authority that has the
    // right ones. Refusing here instead would make one bad 64 KiB on disk an
    // unreadable chat forever - nothing evicts the entry, so every reopen would
    // re-read it and reach the same verdict.
    expect(result.outcome.kind).toBe("ok");
    // The DIGEST is what caught it: the length matched exactly.
    expect(port.partCalls).toContain(published.parts[0].address.sha256);
    // And the correct bytes are filed under the key now, so the NEXT read is
    // incremental again rather than paying for the same repair.
    expect(await cache.get(published.parts[0].address.sha256)).toEqual(
      published.parts[0].bytes,
    );
  });

  it("does not cache bytes that fail their own content address", async () => {
    const published = await publishCloudChat(DEFAULT_PUBLISH);
    const cache = new InMemoryChatPartCache();
    const serving = servingBehaviour(published);
    const poisoned = published.parts[0].address.sha256;
    // Same length again, and declared honestly, so admission can only be
    // refused on the digest.
    const substituted = flipOneByte(published.parts[0].bytes);

    const port = recordingPort({
      resolve: serving.resolve,
      part: (sha256) =>
        sha256 === poisoned
          ? {
              outcome: {
                status: "ok",
                bytesBase64: encodeBase64(substituted),
                byteLength: substituted.byteLength,
              },
            }
          : serving.part(sha256),
    });

    const result = await read(port, cache);

    expect(result.outcome.kind).toBe("corrupt");
    if (result.outcome.kind !== "corrupt") return;
    expect(result.outcome.reason).toBe("digest-mismatch");
    // Nothing was filed under the poisoned digest: had it been, every later read
    // would serve the substituted bytes from disk and never ask again.
    expect(await cache.get(poisoned)).toBeNull();
  });
});

describe("failing closed", () => {
  it("a substituted part refuses the chat rather than shortening it", async () => {
    const published = await publishCloudChat(DEFAULT_PUBLISH);
    const serving = servingBehaviour(published);
    // Serve the SECOND cohort's bytes when the first is asked for: correct,
    // parseable, well-formed shard bytes - just not the ones the head named.
    const port = recordingPort({
      resolve: serving.resolve,
      part: (sha256) =>
        sha256 === published.parts[0].address.sha256
          ? serving.part(published.parts[1].address.sha256)
          : serving.part(sha256),
    });

    const result = await read(port, new InMemoryChatPartCache());

    expect(result.outcome.kind).toBe("corrupt");
    if (result.outcome.kind !== "corrupt") return;
    expect(result.outcome.reason).toBe("byte-length-mismatch");
    // The renderer-safe message carries no digest - a corruption notice is a
    // silly place to hand back an object coordinate.
    expect(result.outcome.message).not.toContain(
      published.parts[0].address.sha256,
    );
    expect(result.outcome.diagnostic).toContain("part 0");
  });

  it("a truncated part is refused, never rendered as a shorter transcript", async () => {
    const published = await publishCloudChat(DEFAULT_PUBLISH);
    const serving = servingBehaviour(published);
    const full = published.parts[1].bytes;
    const port = recordingPort({
      resolve: serving.resolve,
      part: (sha256) =>
        sha256 === published.parts[1].address.sha256
          ? {
              outcome: {
                status: "ok",
                bytesBase64: encodeBase64(full.subarray(0, full.length - 20)),
                byteLength: full.length - 20,
              },
            }
          : serving.part(sha256),
    });

    const result = await read(port, new InMemoryChatPartCache());

    expect(result.outcome.kind).toBe("corrupt");
    if (result.outcome.kind !== "corrupt") return;
    expect(result.outcome.reason).toBe("byte-length-mismatch");
  });

  it("a tampered head document is refused before any part is fetched", async () => {
    const published = await publishCloudChat(DEFAULT_PUBLISH);
    const serving = servingBehaviour(published);
    const port = recordingPort({
      resolve: () => ({
        chat: published.summary,
        outcome: {
          status: "ok",
          // One byte of the title changed: still valid JSON, still a valid
          // head, and no longer the document the row's digest names.
          head: published.headDocument.replace(
            "A published chat",
            "A published chaT",
          ),
          headSha256: published.headSha256,
        },
      }),
      part: serving.part,
    });

    const result = await read(port, new InMemoryChatPartCache());

    expect(result.outcome.kind).toBe("corrupt");
    if (result.outcome.kind !== "corrupt") return;
    expect(result.outcome.reason).toBe("head-digest-mismatch");
    expect(port.partCalls).toEqual([]);
  });

  it("a head whose parts envelope disagrees with its shard lists is refused", async () => {
    const published = await publishCloudChat(DEFAULT_PUBLISH);
    // The exact defect the codec seam exists to catch: an envelope naming a
    // publication other than the one the record describes.
    const forged = withForgedPartsEnvelope(published.headDocument, [
      published.parts[0].address,
    ]);
    const forgedSha = await webCryptoSha256Hex(utf8Bytes(forged));
    const serving = servingBehaviour(published);
    const port = recordingPort({
      resolve: () => ({
        chat: { ...published.summary, headSha256: forgedSha },
        outcome: { status: "ok", head: forged, headSha256: forgedSha },
      }),
      part: serving.part,
    });

    const result = await read(port, new InMemoryChatPartCache());

    expect(result.outcome.kind).toBe("corrupt");
    if (result.outcome.kind !== "corrupt") return;
    expect(result.outcome.reason).toBe("parts-envelope-mismatch");
    expect(port.partCalls).toEqual([]);
  });

  it("a part the head names but storage lacks is its own diagnosis", async () => {
    const published = await publishCloudChat(DEFAULT_PUBLISH);
    const serving = servingBehaviour(published);
    const port = recordingPort({
      resolve: serving.resolve,
      part: (sha256) =>
        sha256 === published.parts[1].address.sha256
          ? { outcome: { status: "not-found" } }
          : serving.part(sha256),
    });

    const result = await read(port, new InMemoryChatPartCache());

    expect(result.outcome.kind).toBe("corrupt");
    if (result.outcome.kind !== "corrupt") return;
    expect(result.outcome.reason).toBe("part-missing");
  });
});

describe("the version gate", () => {
  it("refuses a head above this reader's minimum WITHOUT fetching a part", async () => {
    // A 1.4 writer that declares older readers cannot safely INTERPRET this
    // publication. The minimum may not exceed the head's own version, so
    // exercising it at all requires publishing as a future writer.
    const published = await publishCloudChat({
      ...DEFAULT_PUBLISH,
      payloadMinor: 4,
      minReaderVersion: { major: 1, minor: 4 },
    });
    const port = recordingPort(servingBehaviour(published));

    const result = await read(port, new InMemoryChatPartCache());

    expect(result.outcome.kind).toBe("needs-newer-app");
    if (result.outcome.kind !== "needs-newer-app") return;
    expect(result.outcome.reason).toBe("reader-below-minimum");
    // The property the whole ordering exists for: a chat this build cannot
    // interpret costs one row read and ZERO part egress. Asserted as a call
    // count, because "nothing rendered" would also be true if the parts had
    // been fetched and then discarded.
    expect(port.partCalls).toEqual([]);
    expect(port.resolveCalls).toHaveLength(1);
  });

  it("ADMITS a newer minor that states no minimum - which is what makes the passthrough reachable", async () => {
    const published = await publishCloudChat({
      ...DEFAULT_PUBLISH,
      payloadMinor: 4,
    });
    const port = recordingPort(servingBehaviour(published));

    const result = await read(port, new InMemoryChatPartCache());

    expect(result.outcome.kind).toBe("ok");
    if (result.outcome.kind !== "ok") return;
    expect(result.outcome.chat.schemaVersion).toEqual({ major: 1, minor: 4 });
    expect(port.partCalls).toHaveLength(published.parts.length);
  });

  it("refuses a head on another MAJOR", async () => {
    const published = await publishCloudChat(DEFAULT_PUBLISH);
    const serving = servingBehaviour(published);
    // Forged at the document level: the major is pinned in both the writer AND
    // the reader schema, so no schema in this build will produce one.
    const foreign = published.headDocument.replace(
      '"schemaVersion":{"major":1,"minor":1}',
      '"schemaVersion":{"major":9,"minor":0}',
    );
    const foreignSha = await webCryptoSha256Hex(utf8Bytes(foreign));
    const port = recordingPort({
      resolve: () => ({
        chat: { ...published.summary, headSha256: foreignSha },
        outcome: { status: "ok", head: foreign, headSha256: foreignSha },
      }),
      part: serving.part,
    });

    const result = await read(port, new InMemoryChatPartCache());

    // A foreign major does not parse as a head at all, so it never reaches the
    // gate - it is refused one step earlier, and still before any part moves.
    expect(result.outcome.kind).toBe("corrupt");
    if (result.outcome.kind !== "corrupt") return;
    expect(result.outcome.reason).toBe("schema-rejected");
    expect(port.partCalls).toEqual([]);
  });
});

describe("the states that are not failures", () => {
  it("an unpublished chat is an outcome, not an error", async () => {
    const port = recordingPort({
      resolve: () => ({
        chat: UNPUBLISHED_SUMMARY,
        outcome: { status: "unpublished" },
      }),
      part: () => ({ outcome: { status: "not-found" } }),
    });

    const result = await read(port, new InMemoryChatPartCache());

    expect(result.outcome.kind).toBe("unpublished");
    expect(port.partCalls).toEqual([]);
  });

  it("a chat with NO cloud row at all reads as unpublished, with no summary and no part calls", async () => {
    // The resolve's `missing` arm: doc-era chats that predate publication,
    // guessed ids, and rows this viewer may not read all land here. To a
    // reader they are all the same fact - nothing published to show - and
    // must never surface as a transport error.
    const port = recordingPort({
      resolve: () => ({
        chat: null,
        outcome: { status: "missing" },
      }),
      part: () => ({ outcome: { status: "not-found" } }),
    });

    const result = await read(port, new InMemoryChatPartCache());

    expect(result.outcome.kind).toBe("unpublished");
    expect(result.chat).toBeNull();
    expect(port.partCalls).toEqual([]);
  });

  it("a row owned by somebody else is refused rather than rendered", async () => {
    const port = recordingPort({
      resolve: () => ({
        chat: UNPUBLISHED_SUMMARY,
        outcome: {
          status: "ambiguous-identity",
          resolvedOwnerUserId: "someone-else",
        },
      }),
      part: () => ({ outcome: { status: "not-found" } }),
    });

    const result = await read(port, new InMemoryChatPartCache());

    expect(result.outcome.kind).toBe("ambiguous-identity");
    if (result.outcome.kind !== "ambiguous-identity") return;
    expect(result.outcome.resolvedOwnerUserId).toBe("someone-else");
    expect(port.partCalls).toEqual([]);
  });

  it("a head describing ANOTHER chat is refused before any part is fetched", async () => {
    // The row resolved for the identity that was asked for, and its head is
    // internally perfect - correct digest, correct envelope, shards that
    // cross-check against it. Only the identity INSIDE it disagrees, which no
    // other check on this path can see: the shard cross-check compares parts
    // with the head, never the head with the request.
    const published = await publishCloudChat(DEFAULT_PUBLISH);
    const port = recordingPort(servingBehaviour(published));

    const result = await readCloudChat({
      identity: { ...IDENTITY, chatId: "chat-somewhere-else" },
      port,
      cache: new InMemoryChatPartCache(),
      sha256Hex: webCryptoSha256Hex,
    });

    expect(result.outcome.kind).toBe("ambiguous-identity");
    // Refused on the head, so the foreign transcript costs no part egress.
    expect(port.partCalls).toEqual([]);
  });

  it("a part answered with more base64 than its length allows is refused UNREAD", async () => {
    const published = await publishCloudChat(DEFAULT_PUBLISH);
    const serving = servingBehaviour(published);
    const oversized = published.parts[0].address.sha256;
    const port = recordingPort({
      resolve: serving.resolve,
      part: (sha256) =>
        sha256 === oversized
          ? {
              outcome: {
                status: "ok",
                // Declared honestly; the BODY is what lies. `atob` would expand
                // all of it before any check could run, which is the allocation
                // this refusal exists to avoid.
                byteLength: published.parts[0].bytes.byteLength,
                bytesBase64: "A".repeat(
                  published.parts[0].bytes.byteLength * 8,
                ),
              },
            }
          : serving.part(sha256),
    });

    const result = await read(port, new InMemoryChatPartCache());

    expect(result.outcome.kind).toBe("corrupt");
    if (result.outcome.kind !== "corrupt") return;
    expect(result.outcome.reason).toBe("byte-length-mismatch");
  });

  it("a transport failure PROPAGATES rather than becoming a corrupt chat", async () => {
    const published = await publishCloudChat(DEFAULT_PUBLISH);
    const serving = servingBehaviour(published);
    const port: RecordingPort = {
      ...recordingPort(serving),
      readPart: () => Promise.reject(new Error("socket hung up")),
    };

    await expect(read(port, new InMemoryChatPartCache())).rejects.toThrow(
      "socket hung up",
    );
  });
});
