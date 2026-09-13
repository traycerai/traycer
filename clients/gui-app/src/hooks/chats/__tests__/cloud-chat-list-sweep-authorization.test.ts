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
      cloudChatListAuthorizesRecordSweep(
        {
          isEnabled: true,
          isSuccess: true,
          isError: false,
          error: null,
        },
        true,
      ),
    ).toBe(true);
  });

  it("authorizes on a disabled query - nothing will ever answer", () => {
    expect(
      cloudChatListAuthorizesRecordSweep(
        {
          isEnabled: false,
          isSuccess: false,
          isError: false,
          error: null,
        },
        true,
      ),
    ).toBe(true);
  });

  it("authorizes on E_HOST_UNSUPPORTED - an older host answers it forever", () => {
    expect(
      cloudChatListAuthorizesRecordSweep(
        {
          isEnabled: true,
          isSuccess: false,
          isError: true,
          error: rpcError("E_HOST_UNSUPPORTED"),
        },
        true,
      ),
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
    expect(isCloudChatListSettled(query, true)).toBe(true);
    expect(cloudChatListAuthorizesRecordSweep(query, true)).toBe(false);
  });

  it("refuses an in-flight query", () => {
    expect(
      cloudChatListAuthorizesRecordSweep(
        {
          isEnabled: true,
          isSuccess: false,
          isError: false,
          error: null,
        },
        true,
      ),
    ).toBe(false);
  });

  it("refuses a disabled query when cloud authorization is absent - the point of this whole PR", () => {
    // A disabled query is the predicate's STRONGEST authorizing arm when the
    // session may spend the account's cloud capability: nothing will ever
    // answer, so policing on local records alone is the whole truth
    // available. But `useCloudChatList` now disables itself for TWO reasons -
    // "nothing to ask" and "may not ask" - and only the first one may
    // authorize destruction. An `unverified` session's list is disabled
    // because it may not spend the capability, not because the cloud rows
    // don't exist; treating that the same as "nothing will ever answer" is
    // exactly what would have let the widened admission reap every restored
    // record-less tab on mount.
    const disabledQuery = {
      isEnabled: false,
      isSuccess: false,
      isError: false,
      error: null,
    };
    // The contrast: the SAME disabled query authorizes when the session may
    // spend the capability...
    expect(cloudChatListAuthorizesRecordSweep(disabledQuery, true)).toBe(true);
    // ...and refuses when it may not - the one-argument predicate could not
    // express this distinction at all, and returned `true` on exactly this
    // input.
    expect(cloudChatListAuthorizesRecordSweep(disabledQuery, false)).toBe(
      false,
    );
  });
});

describe("isCloudChatListSettled", () => {
  it("is not settled for a disabled query when cloud authorization is absent", () => {
    // Same conflation, same fix, sharing the rationale with the sweep case
    // above: a disabled query is settled ("nothing will ever answer") only
    // when the reason it is disabled is that there is nothing left to ask.
    // Disabled for want of AUTHORIZATION means the cloud rows exist and this
    // session merely may not look - which the sidebar's "No agents yet." arm
    // must not read as a final, empty answer.
    const disabledQuery = {
      isEnabled: false,
      isSuccess: false,
      isError: false,
    };
    expect(isCloudChatListSettled(disabledQuery, true)).toBe(true);
    expect(isCloudChatListSettled(disabledQuery, false)).toBe(false);
  });
});
