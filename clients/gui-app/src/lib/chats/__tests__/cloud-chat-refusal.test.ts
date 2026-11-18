import { describe, expect, it } from "vitest";
import {
  encodeBase64,
  utf8Bytes,
  webCryptoSha256Hex,
} from "@traycer-clients/shared/cloud-chat/bytes";
import {
  readCloudChat,
  type CloudChatReadOutcome,
} from "@traycer-clients/shared/cloud-chat/cloud-chat-reader";
import { InMemoryChatPartCache } from "@traycer-clients/shared/cloud-chat/part-cache";
import {
  DEFAULT_PUBLISH,
  IDENTITY,
  publishCloudChat,
  recordingPort,
  servingBehaviour,
  UNPUBLISHED_SUMMARY,
} from "@traycer-clients/shared/cloud-chat/__tests__/__fixtures__/published-cloud-chat";
import { describeCloudChatRefusal } from "@/lib/chats/cloud-chat-refusal";

/**
 * What the reader SHOWS when a chat does not render.
 *
 * The tampered-part case is driven through the real read rather than by
 * hand-building an outcome, because the claim under test is end to end: a
 * substituted part must reach the user as a refusal with a message, not as a
 * silently shorter transcript and not as a raw digest.
 */

describe("a tampered part", () => {
  it("refuses to render and surfaces a message carrying no coordinates", async () => {
    const published = await publishCloudChat(DEFAULT_PUBLISH);
    const serving = servingBehaviour(published);
    const substituted = utf8Bytes(
      '{"schemaVersion":{"major":1,"minor":0},"chatId":"chat-1","section":"messages","messages":[],"events":[],"hostPrivate":null}',
    );
    const targeted = published.parts[0].address.sha256;

    const result = await readCloudChat({
      identity: IDENTITY,
      port: recordingPort({
        resolve: serving.resolve,
        part: (sha256) =>
          sha256 === targeted
            ? {
                outcome: {
                  status: "ok",
                  bytesBase64: encodeBase64(substituted),
                  byteLength: substituted.byteLength,
                },
              }
            : serving.part(sha256),
      }),
      cache: new InMemoryChatPartCache(),
      sha256Hex: webCryptoSha256Hex,
    });

    expect(result.outcome.kind).toBe("corrupt");
    const refusal = describeCloudChatRefusal(result.outcome);
    expect(refusal).not.toBeNull();
    if (refusal === null) return;
    expect(refusal.title).toBe("This chat could not be opened");
    expect(refusal.body.length).toBeGreaterThan(0);
    // No digest reaches the user - a corruption notice is a silly place to hand
    // back an object coordinate the read APIs deliberately withhold.
    expect(refusal.body).not.toContain(targeted);
    // And a retry is not offered, because a corrupt publication re-resolves to
    // the same head.
    expect(refusal.isRetryable).toBe(false);
  });
});

describe("the other refusals", () => {
  it("says nothing is published yet, without calling it a failure", async () => {
    const port = recordingPort({
      resolve: () => ({
        chat: UNPUBLISHED_SUMMARY,
        outcome: { status: "unpublished" },
      }),
      part: () => ({ outcome: { status: "not-found" } }),
    });

    const result = await readCloudChat({
      identity: IDENTITY,
      port,
      cache: new InMemoryChatPartCache(),
      sha256Hex: webCryptoSha256Hex,
    });

    const refusal = describeCloudChatRefusal(result.outcome);
    expect(refusal?.title).toBe("Not published yet");
  });

  it("never names the owner an ambiguous identity resolved to", () => {
    const outcome: CloudChatReadOutcome = {
      kind: "ambiguous-identity",
      resolvedOwnerUserId: "someone-elses-user-id",
    };

    const refusal = describeCloudChatRefusal(outcome);

    expect(refusal).not.toBeNull();
    if (refusal === null) return;
    // The refusal exists to stop one person's chat showing under another
    // person's row; naming whose it was would be the same disclosure by prose.
    expect(refusal.body).not.toContain("someone-elses-user-id");
    expect(refusal.title).toBe("This chat could not be identified");
  });

  it("passes the protocol's own version phrasing through unchanged", () => {
    const outcome: CloudChatReadOutcome = {
      kind: "needs-newer-app",
      reason: "reader-below-minimum",
      message:
        "This chat requires a reader on 1.4 or newer; this reader is 1.0",
    };

    // Not re-worded here: two surfaces describing the same refusal differently
    // is exactly what the protocol's fixed phrasing exists to prevent.
    expect(describeCloudChatRefusal(outcome)?.body).toBe(outcome.message);
  });

  it("is null for a chat that read fine", async () => {
    const published = await publishCloudChat(DEFAULT_PUBLISH);
    const result = await readCloudChat({
      identity: IDENTITY,
      port: recordingPort(servingBehaviour(published)),
      cache: new InMemoryChatPartCache(),
      sha256Hex: webCryptoSha256Hex,
    });

    expect(describeCloudChatRefusal(result.outcome)).toBeNull();
  });
});
