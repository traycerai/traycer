import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("sonner", () => {
  // `toast` is CALLABLE as well as a namespace: the transport-class notice
  // deliberately uses the plain `toast(...)` rather than `toast.error(...)`,
  // because a transient, self-healing condition must not be framed as a
  // failure. A namespace-only mock would make that path throw rather than
  // fail an assertion, which is the confusing kind of red.
  const base = vi.fn();
  return {
    toast: Object.assign(base, {
      error: vi.fn(),
      success: vi.fn(),
    }),
  };
});

import { toast } from "sonner";
import {
  toastFromHostError,
  toastFromHostErrorWithDetail,
} from "@/lib/host-error-toast";
import {
  __resetAppLocalNotificationsStoreForTests,
  useAppLocalNotificationsStore,
} from "@/stores/notifications/app-local-notifications-store";
import {
  HostRequestAbortedError,
  HostRpcError,
  HostTransportFailureError,
  RetryableTransportError,
} from "@traycer-clients/shared/host-transport/host-messenger";

function makeError(code: HostRpcError["code"], message: string): HostRpcError {
  return new HostRpcError({
    code,
    message,
    requestId: "req-toast",
    method: "epic.revokeCollaborator",
    fatalDetails: null,
  });
}

function unauthorizedFatal(
  requestId: string,
  method: string,
  reason: string,
  retryable: boolean,
): HostRpcError {
  return new HostRpcError({
    code: "UNAUTHORIZED",
    message: reason,
    requestId,
    method,
    fatalDetails: {
      code: "UNAUTHORIZED",
      reason,
      incompatibleMethods: null,
      upgradeGuidance: null,
      ...(retryable ? { retryable: true } : {}),
    },
  });
}

describe("toastFromHostError", () => {
  afterEach(() => {
    vi.mocked(toast.error).mockClear();
    __resetAppLocalNotificationsStoreForTests();
  });

  it("shows permission copy for FORBIDDEN", () => {
    toastFromHostError(makeError("FORBIDDEN", "test error"), "fallback");
    expect(toast.error).toHaveBeenCalledWith(
      "You don't have permission to do that.",
    );
  });

  it("shows last-owner copy when the host message preserves that reason", () => {
    toastFromHostError(
      makeError("RPC_ERROR", "Cannot revoke the last owner"),
      "Couldn't remove collaborator.",
    );
    expect(toast.error).toHaveBeenCalledWith(
      "Can't revoke the only Owner. Transfer ownership first.",
    );
  });

  it("keeps generic permission copy for other FORBIDDEN errors", () => {
    toastFromHostError(
      makeError("FORBIDDEN", "User cannot revoke someone else"),
      "fallback",
    );
    expect(toast.error).toHaveBeenCalledWith(
      "You don't have permission to do that.",
    );
  });

  // The host's epic role gates state the missing role in a fixed phrase
  // (`auth-helpers.ts`: "User 'x' does not have editor|owner access to ...").
  // Branching on it turns "You don't have permission to do that." - the toast
  // a viewer got for clicking Clone on a shared agent, indistinguishable from
  // a bug - into the reason. The raw ids in the host text stay out of the
  // toast.
  it("names view-only access when the host's editor gate refused", () => {
    toastFromHostError(
      makeError(
        "FORBIDDEN",
        "User 'user-2' does not have editor access to epic 'epic-1'",
      ),
      "Couldn't create agent.",
    );
    expect(toast.error).toHaveBeenCalledWith(
      "You have view-only access to this task, so you can't make changes to it.",
    );
    expect(toast.error).not.toHaveBeenCalledWith(
      expect.stringContaining("user-2"),
    );
  });

  it("names the owner requirement when the host's owner gate refused", () => {
    toastFromHostError(
      makeError(
        "FORBIDDEN",
        "User 'user-2' does not have owner access to epic 'epic-1'",
      ),
      "fallback",
    );
    expect(toast.error).toHaveBeenCalledWith(
      "Only this task's owner can do that.",
    );
  });

  it("shows sign-in copy for UNAUTHORIZED", () => {
    toastFromHostError(makeError("UNAUTHORIZED", "test error"), "fallback");
    expect(toast.error).toHaveBeenCalledWith("Please sign in again.");
  });

  it("uses verify-session copy for retryable UNAUTHORIZED host failures", () => {
    useAppLocalNotificationsStore.getState().activateIdentity("user-1");
    const reason = "Signing key unavailable: request timed out";

    toastFromHostError(
      unauthorizedFatal("req-retryable-auth", "providers.list", reason, true),
      "Couldn't refresh providers.",
    );

    expect(toast.error).toHaveBeenCalledWith(
      "The host couldn't verify your session. Try again in a moment.",
      { id: "host-error:UNAUTHORIZED:UNAUTHORIZED", cancel: null },
    );
    expect(
      useAppLocalNotificationsStore.getState().byId[
        "host.error:UNAUTHORIZED:UNAUTHORIZED"
      ],
    ).toMatchObject({
      message: "The host couldn't verify your session. Try again in a moment.",
      detail: reason,
    });
  });

  it("collapses repeated same-cause fatal failures into one resurfacing feed entry", () => {
    useAppLocalNotificationsStore.getState().activateIdentity("user-1");

    toastFromHostError(
      unauthorizedFatal(
        "req-1",
        "providers.list",
        "Expected 200 OK from the JSON Web Key Set endpoint",
        false,
      ),
      "Couldn't load providers.",
    );
    useAppLocalNotificationsStore
      .getState()
      .markAsRead("host.error:UNAUTHORIZED:UNAUTHORIZED", 10);
    toastFromHostError(
      unauthorizedFatal(
        "req-2",
        "epic.list",
        "Host is not provisioned - sign in on this machine to authorize it",
        false,
      ),
      "Couldn't load epics.",
    );

    const state = useAppLocalNotificationsStore.getState();
    expect(state.orderedIds).toEqual(["host.error:UNAUTHORIZED:UNAUTHORIZED"]);
    expect(state.byId["host.error:UNAUTHORIZED:UNAUTHORIZED"]).toMatchObject({
      message: "Please sign in again.",
      detail:
        "Host is not provisioned - sign in on this machine to authorize it",
      readAt: null,
    });
    expect(toast.error).toHaveBeenCalledTimes(2);
    expect(toast.error).toHaveBeenLastCalledWith("Please sign in again.", {
      id: "host-error:UNAUTHORIZED:UNAUTHORIZED",
      cancel: null,
    });
  });

  it("does not re-flip a recently acknowledged entry back to unread", () => {
    useAppLocalNotificationsStore.getState().activateIdentity("user-1");

    toastFromHostError(
      unauthorizedFatal(
        "req-1",
        "providers.list",
        "Expected 200 OK from the JSON Web Key Set endpoint",
        false,
      ),
      "Couldn't load providers.",
    );
    const readAt = Date.now();
    useAppLocalNotificationsStore
      .getState()
      .markAsRead("host.error:UNAUTHORIZED:UNAUTHORIZED", readAt);
    toastFromHostError(
      unauthorizedFatal(
        "req-2",
        "epic.list",
        "Host is not provisioned - sign in on this machine to authorize it",
        false,
      ),
      "Couldn't load epics.",
    );

    const state = useAppLocalNotificationsStore.getState();
    expect(state.orderedIds).toEqual(["host.error:UNAUTHORIZED:UNAUTHORIZED"]);
    // A recurrence seconds after the user read the entry keeps it read but
    // still refreshes it with the latest cause detail.
    expect(state.byId["host.error:UNAUTHORIZED:UNAUTHORIZED"]).toMatchObject({
      readAt,
      detail:
        "Host is not provisioned - sign in on this machine to authorize it",
    });
    expect(state.unreadCount).toBe(0);
  });

  it("dedupes transport-failure toasts under one id without a feed entry", () => {
    useAppLocalNotificationsStore.getState().activateIdentity("user-1");

    toastFromHostError(
      new HostTransportFailureError({
        code: "RPC_ERROR",
        message: "WebSocket closed before next frame",
        requestId: "req-transport",
        method: "epic.list",
        fatalDetails: null,
      }),
      "Couldn't load epics.",
    );

    // Policy changed deliberately (T5 item 5b): a transport cause no longer
    // renders through `reportableErrorToast` at all. The old assertion's
    // `cancel: null` was an artifact of `reportIssueAvailable` defaulting to
    // false under test - in the desktop app that flag is TRUE, so this path
    // really did attach a "Report issue" button to ordinary network weather,
    // across ~158 gesture call sites. The no-feed-entry half of this test
    // still holds and is kept.
    expect(toast.error).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalledTimes(1);
    expect(useAppLocalNotificationsStore.getState().orderedIds).toHaveLength(0);
  });

  it("shows rebind-blocked copy for WORKTREE_REBIND_BLOCKED", () => {
    toastFromHostError(
      makeError("WORKTREE_REBIND_BLOCKED", "Cannot rebind: chat is active."),
      "Couldn't create worktree.",
    );
    expect(toast.error).toHaveBeenCalledWith(
      "Stop the active run before rebinding the worktree.",
    );
  });

  it("shows upgrade copy for E_HOST_UNSUPPORTED without an app-local failure row", () => {
    useAppLocalNotificationsStore.getState().activateIdentity("user-1");

    toastFromHostError(
      new HostRpcError({
        code: "E_HOST_UNSUPPORTED",
        message: "host.notifications.resolve is not supported",
        requestId: "req-unsupported-resolve",
        method: "host.notifications.resolve",
        fatalDetails: {
          code: "E_HOST_UNSUPPORTED",
          reason: "Method not advertised by this host",
          incompatibleMethods: null,
          upgradeGuidance: null,
        },
      }),
      "Couldn't dismiss the notification.",
    );

    expect(toast.error).toHaveBeenCalledWith(
      "This needs a newer Traycer host. Update the host to continue.",
      {
        id: "host-error:E_HOST_UNSUPPORTED:E_HOST_UNSUPPORTED",
        cancel: null,
      },
    );
    expect(useAppLocalNotificationsStore.getState().orderedIds).toHaveLength(0);
  });

  it("shows the fallback for any other error code", () => {
    toastFromHostError(
      makeError("RPC_ERROR", "test error"),
      "Couldn't do the thing.",
    );
    expect(toast.error).toHaveBeenCalledWith("Couldn't do the thing.");
  });

  it("shows the fallback for other error codes", () => {
    toastFromHostError(
      makeError("INCOMPATIBLE", "test error"),
      "custom fallback",
    );
    expect(toast.error).toHaveBeenCalledWith("custom fallback");
  });

  it("can append raw host detail for scoped mutation failures", () => {
    toastFromHostErrorWithDetail(
      makeError("RPC_ERROR", "No connected OpenCode providers."),
      "Couldn't start terminal agent session.",
    );
    expect(toast.error).toHaveBeenCalledWith(
      "Couldn't start terminal agent session. No connected OpenCode providers.",
    );
  });

  // Review #1297 finding 2: host detail is unbounded by construction. The
  // producer that motivated forwarding it - `worktreeCreateFailed` - joins one
  // line per failed workspace, each an absolute path plus raw git stderr, so
  // appended verbatim it is an arbitrarily tall toast.
  describe("bounds free-form host detail", () => {
    it("keeps a realistic single-line worktree reason intact", () => {
      // The failure this whole change set exists for. Cutting it would drop
      // the clause that says WHY, which is the entire value of forwarding it.
      const reason =
        "git worktree add failed for traycer/tidy-badger at " +
        "/Users/tgill/.traycer/worktrees/traycerai__traycer-internal/" +
        "repo-tidy-badger: fatal: a branch named 'traycer/tidy-badger' " +
        "already exists";
      toastFromHostErrorWithDetail(
        makeError("RPC_ERROR", reason),
        "Couldn't create agent.",
      );
      expect(toast.error).toHaveBeenCalledWith(
        `Couldn't create agent. ${reason}`,
      );
    });

    it("shows the first failure and COUNTS the rest for a multi-entry failure", () => {
      toastFromHostErrorWithDetail(
        makeError(
          "RPC_ERROR",
          ["first failed: fatal: a", "second failed: fatal: b", ""].join("\n"),
        ),
        "Couldn't create agent.",
      );
      // The count, not a silent first-line take: dropping the other folders
      // without saying so is the quiet omission this change set removes. The
      // trailing blank line must not be counted as a third entry.
      expect(toast.error).toHaveBeenCalledWith(
        "Couldn't create agent. first failed: fatal: a (+1 more)",
      );
    });

    it("truncates a single line that is a diagnostic dump rather than a sentence", () => {
      toastFromHostErrorWithDetail(
        makeError("RPC_ERROR", "x".repeat(400)),
        "Couldn't create agent.",
      );
      // Pinned exactly rather than "is shorter than the input": the cut has to
      // be at the documented cap and it has to SAY it was cut.
      expect(toast.error).toHaveBeenCalledWith(
        `Couldn't create agent. ${"x".repeat(240)}…`,
      );
    });

    it("falls back to the plain copy when the detail is only whitespace", () => {
      toastFromHostErrorWithDetail(
        makeError("RPC_ERROR", "\n  \n"),
        "Couldn't create agent.",
      );
      expect(toast.error).toHaveBeenCalledWith("Couldn't create agent.");
    });
  });
});

describe("transport-class causes never reach a reportable toast", () => {
  beforeEach(() => {
    // BEFORE, not after: `toast` is one shared mock function across this file
    // and the suites above leave calls on it, so a count assertion that only
    // cleared afterwards would inherit them.
    vi.clearAllMocks();
    __resetAppLocalNotificationsStoreForTests();
  });

  afterEach(() => {
    vi.clearAllMocks();
    __resetAppLocalNotificationsStoreForTests();
  });

  function transportFailure(method: string): HostTransportFailureError {
    return new HostTransportFailureError({
      code: "RPC_ERROR",
      message: "Host is unreachable",
      requestId: `req-${method}`,
      method,
      fatalDetails: null,
    });
  }

  it("renders a plain, non-reportable notice instead of an error toast", () => {
    toastFromHostError(transportFailure("terminal.create"), "Couldn't create.");

    // The harm this replaces: `reportableErrorToast` drives `toast.error` AND
    // attaches a Report Issue affordance, so every flap invited a support
    // ticket for ordinary network weather across ~158 gesture call sites.
    expect(toast.error).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalledTimes(1);
  });

  it("does not deposit a host-error notification that outlives the blip", () => {
    toastFromHostError(transportFailure("chat.rename"), "Couldn't rename.");

    expect(useAppLocalNotificationsStore.getState().orderedIds).toHaveLength(0);
  });

  it("collapses many gestures during one flap into a single toast id", () => {
    // A session-wide condition, not a per-operation failure: five gestures
    // colliding with one outage must read as one line. The default dedupe key
    // is per-operation, which is right for genuine failures and wrong here.
    toastFromHostError(transportFailure("terminal.create"), "a");
    toastFromHostError(transportFailure("chat.rename"), "b");
    toastFromHostErrorWithDetail(transportFailure("agent.configure"), "c");

    const ids = vi
      .mocked(toast)
      .mock.calls.map((call) => call[1]?.id)
      .filter((id): id is string => id !== undefined);
    expect(ids).toHaveLength(3);
    expect(new Set(ids).size).toBe(1);
  });

  function retryableTransportFailure(
    method: string,
  ): HostTransportFailureError {
    return new RetryableTransportError({
      code: "RPC_ERROR",
      message: "Dial failed before the request was sent",
      requestId: `req-${method}`,
      method,
      fatalDetails: null,
    });
  }

  it("only claims the request didn't go through when the host provably never dispatched it", () => {
    // `RetryableTransportError` is the pre-send subclass: the request frame
    // never reached the host, which is exactly what makes it safe to retry a
    // non-idempotent method. A plain `HostTransportFailureError` is the
    // AMBIGUOUS post-send drop - the host may well have executed the call and
    // only the answer was lost - so telling the user it "didn't go through"
    // invites them to repeat a side effect that already happened. Deleting a
    // chat twice is the cheap version of that mistake.
    toastFromHostError(retryableTransportFailure("terminal.create"), "a");
    toastFromHostError(transportFailure("epic.deleteChat"), "b");

    const messages = vi
      .mocked(toast)
      .mock.calls.map((call) => call[0])
      .filter((message): message is string => typeof message === "string");
    expect(messages).toHaveLength(2);
    expect(messages[0]).toContain("didn't go through");
    expect(messages[1]).not.toContain("didn't go through");
    // Stating the outcome is unknown, not merely declining to state it: a
    // notice that says nothing about the operation reads as "it failed" too.
    expect(messages[1]).toMatch(/may or may not have gone through/i);
  });

  it("keeps the ambiguous notice on its own id so a pre-send notice cannot overwrite it", () => {
    // One shared id is right for one shared statement. These are two different
    // statements, and the ambiguous one is the load-bearing one - collapsing it
    // under a later "that didn't go through" would restore the overclaim by
    // the back door.
    toastFromHostError(transportFailure("epic.deleteChat"), "a");
    toastFromHostError(retryableTransportFailure("terminal.create"), "b");

    const ids = vi
      .mocked(toast)
      .mock.calls.map((call) => call[1]?.id)
      .filter((id): id is string => id !== undefined);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
  });

  function hostAttestedNoDispatchTimeout(
    method: string,
  ): HostTransportFailureError {
    // Exactly what `ws-rpc-client.ts`'s `hostFatalError` mints for the host's
    // typed `RPC_REQUEST_TIMEOUT` fatal: the RETRYABLE subclass, and yet
    // carrying the host's fatal frame in `fatalDetails`. Both halves are
    // deliberate upstream - the host ANSWERED, so there is a frame, and what it
    // answered is "I never dispatched your request", which is precisely the
    // no-dispatch guarantee that makes retrying a non-idempotent method safe.
    return new RetryableTransportError({
      code: "RPC_ERROR",
      message: "Host timed out awaiting the request frame",
      requestId: `req-${method}`,
      method,
      fatalDetails: {
        code: "RPC_REQUEST_TIMEOUT",
        reason: "Host timed out awaiting the request frame",
        incompatibleMethods: null,
        upgradeGuidance: null,
        retryable: true,
      },
    });
  }

  it("reads a retryable attestation as transport even though it carries fatal details", () => {
    // The discriminator cannot be `fatalDetails === null` alone. On this error
    // `fatalDetails` is an ATTESTATION ("safe to retry, never dispatched"), not
    // a VERDICT ("the host was reached and refused") - opposite meanings behind
    // one field. Classifying it as a verdict is what turned a recoverable
    // transport condition into a durable failure row with a Report Issue
    // button, which is the exact shape this whole branch exists to remove.
    useAppLocalNotificationsStore.getState().activateIdentity("user-1");

    toastFromHostError(
      hostAttestedNoDispatchTimeout("terminal.create"),
      "Couldn't create terminal.",
    );

    expect(toast.error).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalledTimes(1);
    expect(useAppLocalNotificationsStore.getState().orderedIds).toHaveLength(0);
  });

  it("keeps the no-dispatch guarantee in the copy for a retryable attestation", () => {
    // Fixing the classifier alone would move the bug one layer down: the
    // verdict branch keys on `code === "RPC_ERROR"` plus a non-empty reason,
    // which this error ALSO matches, so it would have rendered the host's raw
    // timeout reason as a terminal verdict.
    toastFromHostError(
      hostAttestedNoDispatchTimeout("chat.delete"),
      "Couldn't delete chat.",
    );

    const message = vi.mocked(toast).mock.calls[0][0];
    expect(message).toContain("didn't go through");
    expect(message).not.toContain("Host timed out awaiting the request frame");
  });

  function requestOnlyUnaryTimeout(method: string): HostTransportFailureError {
    // What `RemoteSession.unaryTimeoutError` mints when ONE unary outlives its
    // response deadline. `rejectUnary` tombstones that single stream and closes
    // it; the session stays `ready` and no reconnect is scheduled.
    return new HostTransportFailureError({
      code: "RPC_ERROR",
      message: `Remote unary '${method}' timed out awaiting a response`,
      requestId: `req-${method}`,
      method,
      fatalDetails: null,
    });
  }

  it("never promises a reconnection that is not happening", () => {
    // Neither of these errors proves session recovery is active, and one of
    // them proves the opposite: a request-only unary timeout leaves the session
    // ready with nothing redialling. Promising recovery there tells the user to
    // wait for something that will never arrive.
    //
    // The ambiguous arm cannot be split, and that is stated rather than worked
    // around: a post-send socket drop (session genuinely lost, redial running)
    // and a unary timeout (session healthy) are both a plain
    // `HostTransportFailureError` with null `fatalDetails`. With no fact to
    // separate them, the honest copy is the one that claims neither. Narrating
    // recovery is the session-level affordance's job, not this toast's.
    toastFromHostError(requestOnlyUnaryTimeout("chat.rename"), "a");
    toastFromHostError(hostAttestedNoDispatchTimeout("terminal.create"), "b");
    toastFromHostError(retryableTransportFailure("epic.create"), "c");

    const messages = vi
      .mocked(toast)
      .mock.calls.map((call) => call[0])
      .filter((message): message is string => typeof message === "string");
    expect(messages).toHaveLength(3);
    for (const message of messages) {
      expect(message).not.toMatch(/reconnect/i);
    }
  });

  function terminalTransportFailure(method: string): HostTransportFailureError {
    // Exactly the shape `RemoteSession.notReadyRejection` mints for a request
    // parked against a session that has gone terminal: the CLASS is transport,
    // the `code` is the generic `RPC_ERROR`, and the real verdict rides in
    // `fatalDetails`.
    return new HostTransportFailureError({
      code: "RPC_ERROR",
      message: "Remote session is closed",
      requestId: `req-${method}`,
      method,
      fatalDetails: {
        code: "PLAN_RESTRICTED",
        reason: "Remote host connectivity requires a paid plan",
        incompatibleMethods: null,
        upgradeGuidance: null,
      },
    });
  }

  it("keeps FATAL handling for a transport-class failure carrying a terminal verdict", () => {
    // The mirror image of the mistake this whole branch exists to fix. A
    // session closed by plan restriction, protocol incompatibility or revoked
    // access settles its parked requests as `HostTransportFailureError` - so
    // classifying on the class alone renders a FATAL as transport, promising a
    // reconnect that is not scheduled and burying the one thing the user could
    // act on. `fatalDetails` is the discriminator: a verdict means the host was
    // reached and answered, which is never a connection statement.
    useAppLocalNotificationsStore.getState().activateIdentity("user-1");

    toastFromHostError(
      terminalTransportFailure("epic.list"),
      "Couldn't load epics.",
    );

    expect(toast).not.toHaveBeenCalled();
    // The copy states the CONDITION, not the operation. The caller's fallback
    // ("Couldn't load epics.") names something that was never attempted, and
    // the wire `code` is the generic `RPC_ERROR`, so routing on it alone would
    // land there.
    expect(vi.mocked(toast.error).mock.calls[0][0]).toBe(
      "Remote host connectivity requires a paid plan",
    );
    // And it deposits the durable row, whose detail carries the remediation -
    // the condition outlives the toast because, unlike a blip, it will not
    // heal on its own.
    const state = useAppLocalNotificationsStore.getState();
    expect(state.orderedIds).toHaveLength(1);
    expect(state.byId[state.orderedIds[0]]).toMatchObject({
      detail: "Remote host connectivity requires a paid plan",
    });
  });

  it("stays completely silent for an aborted request", () => {
    // `HostRequestAbortedError extends HostTransportFailureError`, but it is
    // not a network condition at all - a caller-owned authority was replaced
    // or disposed (tab closed, host rebound). Saying "reconnecting" for what
    // was effectively a user navigation would be a NEW false statement.
    toastFromHostError(
      new HostRequestAbortedError({
        message: "authority replaced",
        requestId: "req-abort",
        method: "epic.subscribe",
      }),
      "Couldn't subscribe.",
    );

    expect(toast).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("leaves a retryable UNAUTHORIZED on its own reportable copy", () => {
    // The reason the branch is `instanceof HostTransportFailureError` and NOT
    // `isTransientHostRpcFailure`: the broader predicate also matches a
    // host-side JWKS outage, where the host WAS reached and DID answer. That
    // is not a connection statement and must keep its distinct copy rather
    // than being swallowed into the generic reconnecting notice.
    toastFromHostError(
      unauthorizedFatal("req-jwks", "epic.subscribe", "jwks unreachable", true),
      "Couldn't subscribe.",
    );

    expect(toast).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledTimes(1);
  });
});
