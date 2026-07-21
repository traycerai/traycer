import { describe, expect, it } from "vitest";
import {
  buildNotificationActivationEnvelope,
  feedIdFromEnvelopeFeed,
  parseNotificationActivationPayload,
} from "@/lib/notifications/notification-activation-envelope";

describe("notification activation envelope", () => {
  it("round-trips a V1 envelope through build and parse", () => {
    const envelope = buildNotificationActivationEnvelope({
      route: { kind: "chat", epicId: "epic-1", chatId: "chat-1" },
      feed: { source: "host", id: "n-1" },
      originHostId: "host-a",
    });

    expect(envelope).toEqual({
      kind: "notificationActivation",
      version: 1,
      route: { kind: "chat", epicId: "epic-1", chatId: "chat-1" },
      feed: { source: "host", id: "n-1" },
      originHostId: "host-a",
    });
    expect(feedIdFromEnvelopeFeed(envelope.feed)).toBe("host:n-1");
    expect(parseNotificationActivationPayload(envelope)).toEqual({
      kind: "v1",
      envelope,
    });
  });

  it("accepts null originHostId for host-less rows", () => {
    const envelope = buildNotificationActivationEnvelope({
      route: { kind: "epic", epicId: "epic-2" },
      feed: { source: "app-local", id: "local-1" },
      originHostId: null,
    });

    expect(parseNotificationActivationPayload(envelope)).toEqual({
      kind: "v1",
      envelope,
    });
    expect(feedIdFromEnvelopeFeed(envelope.feed)).toBe("app-local:local-1");
  });

  it("falls back to a legacy raw route payload", () => {
    const payload = {
      kind: "artifact",
      epicId: "epic-3",
      artifactId: "art-1",
      threadId: "thread-1",
    };

    expect(parseNotificationActivationPayload(payload)).toEqual({
      kind: "legacy",
      payload: {
        kind: "artifact",
        epicId: "epic-3",
        artifactId: "art-1",
        threadId: "thread-1",
      },
    });
  });

  it("reports unknown for non-objects and unrecognized shapes", () => {
    expect(parseNotificationActivationPayload(null)).toEqual({
      kind: "unknown",
    });
    expect(parseNotificationActivationPayload("chat")).toEqual({
      kind: "unknown",
    });
    expect(
      parseNotificationActivationPayload({ kind: "not-a-payload" }),
    ).toEqual({
      kind: "unknown",
    });
  });

  it("rejects malformed V1 envelopes and does not fall through to legacy", () => {
    const base = {
      kind: "notificationActivation",
      version: 1,
      route: { kind: "epic", epicId: "epic-1" },
      feed: { source: "host", id: "n-1" },
      originHostId: "host-a",
    };

    expect(parseNotificationActivationPayload({ ...base, version: 2 })).toEqual(
      { kind: "unknown" },
    );
    expect(
      parseNotificationActivationPayload({ ...base, kind: "other" }),
    ).toEqual({ kind: "unknown" });
    expect(
      parseNotificationActivationPayload({ ...base, feed: undefined }),
    ).toEqual({ kind: "unknown" });
    expect(
      parseNotificationActivationPayload({
        ...base,
        feed: { source: "host", id: "" },
      }),
    ).toEqual({ kind: "unknown" });
    expect(
      parseNotificationActivationPayload({
        ...base,
        feed: { source: "device", id: "n-1" },
      }),
    ).toEqual({ kind: "unknown" });
    expect(
      parseNotificationActivationPayload({
        ...base,
        originHostId: 42,
      }),
    ).toEqual({ kind: "unknown" });
    expect(
      parseNotificationActivationPayload({
        ...base,
        route: { kind: "epic" },
      }),
    ).toEqual({ kind: "unknown" });
  });

  it("builds feed ids that match merged-notification feed prefixes", () => {
    expect(feedIdFromEnvelopeFeed({ source: "host", id: "abc" })).toBe(
      "host:abc",
    );
    expect(feedIdFromEnvelopeFeed({ source: "global", id: "g-1" })).toBe(
      "global:g-1",
    );
    expect(feedIdFromEnvelopeFeed({ source: "app-local", id: "a:1" })).toBe(
      "app-local:a:1",
    );
  });
});
