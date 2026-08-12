import { describe, expect, it } from "vitest";
import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import {
  cloudChatListAuthorizesRecordSweep,
  isCloudChatListSettled,
} from "@/hooks/chats/use-cloud-chat-queries";

/**
 * The record-liveness sweep closes tabs it cannot prove alive and is not
 * undone by a later, better answer - so the one arm where this predicate is
 * STRICTER than plain settledness is the whole point: a transiently failed
 * list has produced no evidence about any chat, and its `data === undefined`
 * must not read as "no cloud rows".
 */

function rpcError(code: "RPC_ERROR" | "E_HOST_UNSUPPORTED"): HostRpcError {
  return new HostRpcError({
    code,
    message: `test ${code}`,
    requestId: "req-1",
    method: "epic.listCloudChats",
    fatalDetails: null,
  });
}

describe("cloudChatListAuthorizesRecordSweep", () => {
  it("authorizes on success", () => {
    expect(
      cloudChatListAuthorizesRecordSweep({
        isEnabled: true,
        isSuccess: true,
        isError: false,
        error: null,
      }),
    ).toBe(true);
  });

  it("authorizes on a disabled query - nothing will ever answer", () => {
    expect(
      cloudChatListAuthorizesRecordSweep({
        isEnabled: false,
        isSuccess: false,
        isError: false,
        error: null,
      }),
    ).toBe(true);
  });

  it("authorizes on E_HOST_UNSUPPORTED - an older host answers it forever", () => {
    expect(
      cloudChatListAuthorizesRecordSweep({
        isEnabled: true,
        isSuccess: false,
        isError: true,
        error: rpcError("E_HOST_UNSUPPORTED"),
      }),
    ).toBe(true);
  });

  it("refuses a transient failure, even though that failure is SETTLED", () => {
    const query = {
      isEnabled: true,
      isSuccess: false,
      isError: true,
      error: rpcError("RPC_ERROR"),
    };
    // The divergence under test: settled says yes, sweep authorization says
    // no. A consumer that reaches for the settled predicate to gate a
    // destructive decision reintroduces exactly the reap this pins against.
    expect(isCloudChatListSettled(query)).toBe(true);
    expect(cloudChatListAuthorizesRecordSweep(query)).toBe(false);
  });

  it("refuses an in-flight query", () => {
    expect(
      cloudChatListAuthorizesRecordSweep({
        isEnabled: true,
        isSuccess: false,
        isError: false,
        error: null,
      }),
    ).toBe(false);
  });
});
