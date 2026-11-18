import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appLogger } from "@/lib/logger";
import { deliveryRestoreAckKey } from "@/lib/persist";
import {
  readPersistedDeliveryRestoreAck,
  writePersistedDeliveryRestoreAck,
} from "@/lib/chats/delivery-restore-ack-persistence";

const CHAT_ID = "chat-ack-persistence";

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
  window.localStorage.clear();
});

describe("delivery-restore-ack-persistence", () => {
  it("round-trips a written acknowledgement", () => {
    expect(readPersistedDeliveryRestoreAck(CHAT_ID)).toBeNull();

    writePersistedDeliveryRestoreAck(CHAT_ID, {
      messageId: "message-1",
      expectedRevision: 3,
    });

    expect(readPersistedDeliveryRestoreAck(CHAT_ID)).toEqual({
      messageId: "message-1",
      expectedRevision: 3,
    });
    // Written under the exact key builder, not a private shape of its own.
    expect(
      JSON.parse(
        window.localStorage.getItem(deliveryRestoreAckKey(CHAT_ID)) ?? "null",
      ),
    ).toEqual({ messageId: "message-1", expectedRevision: 3 });
  });

  it("a later write for the same chat overwrites the earlier one", () => {
    writePersistedDeliveryRestoreAck(CHAT_ID, {
      messageId: "message-1",
      expectedRevision: 1,
    });
    writePersistedDeliveryRestoreAck(CHAT_ID, {
      messageId: "message-2",
      expectedRevision: 5,
    });

    expect(readPersistedDeliveryRestoreAck(CHAT_ID)).toEqual({
      messageId: "message-2",
      expectedRevision: 5,
    });
  });

  it("writing null clears the key entirely, not merely to a null-ish value", () => {
    writePersistedDeliveryRestoreAck(CHAT_ID, {
      messageId: "message-1",
      expectedRevision: 1,
    });
    expect(
      window.localStorage.getItem(deliveryRestoreAckKey(CHAT_ID)),
    ).not.toBeNull();

    writePersistedDeliveryRestoreAck(CHAT_ID, null);

    expect(
      window.localStorage.getItem(deliveryRestoreAckKey(CHAT_ID)),
    ).toBeNull();
    expect(readPersistedDeliveryRestoreAck(CHAT_ID)).toBeNull();
  });

  it("keeps chats independent - writing/clearing one leaves another's marker untouched", () => {
    writePersistedDeliveryRestoreAck("chat-a", {
      messageId: "message-1",
      expectedRevision: 1,
    });
    writePersistedDeliveryRestoreAck("chat-b", {
      messageId: "message-2",
      expectedRevision: 2,
    });

    writePersistedDeliveryRestoreAck("chat-a", null);

    expect(readPersistedDeliveryRestoreAck("chat-a")).toBeNull();
    expect(readPersistedDeliveryRestoreAck("chat-b")).toEqual({
      messageId: "message-2",
      expectedRevision: 2,
    });
  });

  it("reads malformed JSON as null", () => {
    window.localStorage.setItem(deliveryRestoreAckKey(CHAT_ID), "{not json");

    expect(readPersistedDeliveryRestoreAck(CHAT_ID)).toBeNull();
  });

  it("reads a non-object JSON value as null", () => {
    window.localStorage.setItem(deliveryRestoreAckKey(CHAT_ID), "42");

    expect(readPersistedDeliveryRestoreAck(CHAT_ID)).toBeNull();
  });

  it("reads an object missing messageId as null", () => {
    window.localStorage.setItem(
      deliveryRestoreAckKey(CHAT_ID),
      JSON.stringify({ expectedRevision: 1 }),
    );

    expect(readPersistedDeliveryRestoreAck(CHAT_ID)).toBeNull();
  });

  it("reads an empty-string messageId as null", () => {
    window.localStorage.setItem(
      deliveryRestoreAckKey(CHAT_ID),
      JSON.stringify({ messageId: "", expectedRevision: 1 }),
    );

    expect(readPersistedDeliveryRestoreAck(CHAT_ID)).toBeNull();
  });

  it("reads a non-string messageId as null", () => {
    window.localStorage.setItem(
      deliveryRestoreAckKey(CHAT_ID),
      JSON.stringify({ messageId: 1, expectedRevision: 1 }),
    );

    expect(readPersistedDeliveryRestoreAck(CHAT_ID)).toBeNull();
  });

  it.each([
    ["zero", 0],
    ["negative", -1],
    ["fractional", 1.5],
  ])("reads a %s expectedRevision as null", (_label, expectedRevision) => {
    window.localStorage.setItem(
      deliveryRestoreAckKey(CHAT_ID),
      JSON.stringify({ messageId: "message-1", expectedRevision }),
    );

    expect(readPersistedDeliveryRestoreAck(CHAT_ID)).toBeNull();
  });

  it("reads a missing expectedRevision as null", () => {
    window.localStorage.setItem(
      deliveryRestoreAckKey(CHAT_ID),
      JSON.stringify({ messageId: "message-1" }),
    );

    expect(readPersistedDeliveryRestoreAck(CHAT_ID)).toBeNull();
  });

  it("a read that throws warns and returns null rather than crashing", () => {
    const warning = vi
      .spyOn(appLogger, "warn")
      .mockImplementation(() => undefined);
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });

    expect(readPersistedDeliveryRestoreAck(CHAT_ID)).toBeNull();
    expect(warning).toHaveBeenCalledOnce();
  });

  it("a write that throws warns and does not crash the caller", () => {
    const warning = vi
      .spyOn(appLogger, "warn")
      .mockImplementation(() => undefined);
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("quota", "QuotaExceededError");
    });

    expect(() =>
      writePersistedDeliveryRestoreAck(CHAT_ID, {
        messageId: "message-1",
        expectedRevision: 1,
      }),
    ).not.toThrow();
    expect(warning).toHaveBeenCalledOnce();
  });
});
