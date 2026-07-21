import { useCallback, useRef } from "react";
import { useNavigate } from "@tanstack/react-router";
import type { HostRpcRegistry } from "@/lib/host";
import { useHostBinding } from "@/lib/host";
import { useHostMutation } from "@/hooks/host/use-host-query";
import { toastFromHostError } from "@/lib/host-error-toast";
import { notificationsMutationKeys } from "@/lib/query-keys";
import {
  routeNotification,
  type NotificationPayload,
} from "@/lib/notifications";

export type NotificationActivationOutcome = "success" | "failure";

export interface NotificationActivationInput {
  readonly payload: NotificationPayload;
  readonly receivedAt: number;
  /** Feed correlation for this activation's pending-row exposure. `null`
   * when there is no feed identity to track (a legacy native payload). */
  readonly feedId: string | null;
  /** Fires exactly once with the terminal outcome: `"success"` after
   * preflight succeeds (or immediately when no preflight is required),
   * `"failure"` if the preflight rejects. Never fires for a call ignored by
   * the in-flight guard below. */
  readonly onResult: ((outcome: NotificationActivationOutcome) => void) | null;
}

export interface NotificationActivationController {
  readonly activate: (input: NotificationActivationInput) => void;
  /** The feedId currently mid-preflight (routed, awaiting the host round
   * trip), or `null` when nothing from this hook instance is in flight.
   * Callers use this to disable/pending only that one row. */
  readonly pendingFeedId: string | null;
}

interface NotificationPreflightVariables {
  readonly epicId: string;
  readonly feedId: string | null;
  readonly onResult: ((outcome: NotificationActivationOutcome) => void) | null;
  readonly requestId: number;
  /** Active host id captured synchronously when the preflight started, for
   * the origin guard in `complete()` below. */
  readonly originHostId: string | null;
}

/** A durable host feed id is prefixed `host:` by `merged-notifications.ts`'s
 * `hostFeedId`; only those carry a host to guard against a switch. */
function isHostFeedId(feedId: string | null): boolean {
  return feedId !== null && feedId.startsWith("host:");
}

/**
 * Opens feed-backed notifications through the default host scope.
 *
 * Routes synchronously exactly once per `activate()` call, then - only when
 * the payload names a shared epic - runs `epic.listCollaborators` as a
 * preflight and reports one `"success"`/`"failure"` completion through
 * `onResult`. `epic.listCollaborators` is intentionally used after routing
 * because the host repairs local collaboration metadata from that
 * authoritative response; routing happens first so the surface does not feel
 * inert while the repair request is in flight. If this hook is mounted
 * outside a host runtime, activation falls back to pure routing so existing
 * browser-only tests and shells keep working.
 *
 * Only one activation may be in flight per hook instance at a time - a
 * repeated click while a preflight is pending is ignored outright rather
 * than starting a second preflight, and a request-id check discards any
 * stale mutation callback that resolves after its activation already
 * completed (or was itself never the active one), so a caller's `onResult`
 * fires exactly once per accepted `activate()` call.
 */
export function useNotificationActivation(): NotificationActivationController {
  const binding = useHostBinding();
  const client = binding?.hostClient ?? null;
  const navigate = useNavigate();
  const requestIdRef = useRef(0);
  const activeRequestIdRef = useRef<number | null>(null);

  const complete = useCallback(
    (
      variables: NotificationPreflightVariables,
      outcome: NotificationActivationOutcome,
    ) => {
      if (activeRequestIdRef.current !== variables.requestId) return;
      activeRequestIdRef.current = null;
      // Routing already happened synchronously and cannot be rolled back,
      // but a host feed id may only be acknowledged while its captured
      // origin host is still the active one - the deliberately asynchronous
      // preflight leaves a window for the active host to switch underneath
      // it. Read the client's CURRENT active host id here (not a React
      // snapshot) so this reflects an in-place client rebind, then settle
      // the row as unread/no-acknowledgment (same as a genuine failure,
      // without the error toast - nothing actually failed) rather than
      // acknowledge against whichever host is active now.
      if (
        outcome === "success" &&
        isHostFeedId(variables.feedId) &&
        (client?.getActiveHostId() ?? null) !== variables.originHostId
      ) {
        variables.onResult?.("failure");
        return;
      }
      variables.onResult?.(outcome);
    },
    [client],
  );

  const mutation = useHostMutation<
    HostRpcRegistry,
    "epic.listCollaborators",
    unknown,
    NotificationPreflightVariables
  >({
    client,
    method: "epic.listCollaborators",
    mapVariables: (variables) => ({ epicId: variables.epicId }),
    options: {
      mutationKey: notificationsMutationKeys.activate(),
      onSuccess: (_data, variables) => {
        complete(variables, "success");
      },
      onError: (error, variables) => {
        toastFromHostError(error, "Couldn't open the shared epic.");
        complete(variables, "failure");
      },
    },
  });

  const activate = useCallback(
    (input: NotificationActivationInput) => {
      if (activeRequestIdRef.current !== null) {
        // One activation in flight at a time; ignore a repeated click
        // instead of starting a second preflight for it.
        return;
      }
      const epicId = getNotificationPreflightEpicId(input.payload);
      routeNotification(navigate, input.payload, input.receivedAt);
      if (epicId === null || binding === null) {
        input.onResult?.("success");
        return;
      }
      const requestId = ++requestIdRef.current;
      activeRequestIdRef.current = requestId;
      mutation.mutate({
        epicId,
        feedId: input.feedId,
        onResult: input.onResult,
        requestId,
        // Captured synchronously off the live client, mirroring
        // `merged-notifications.ts`'s `captureHostNotificationMutationContext`
        // - the same imperative getter, read at the same "preflight start"
        // moment, so a later in-place client rebind is detectable at
        // completion regardless of whether React re-rendered in between.
        originHostId: client?.getActiveHostId() ?? null,
      });
    },
    [binding, client, mutation, navigate],
  );

  return {
    activate,
    pendingFeedId: mutation.isPending ? mutation.variables.feedId : null,
  };
}

function getNotificationPreflightEpicId(
  payload: NotificationPayload,
): string | null {
  switch (payload.kind) {
    case "epic":
      return payload.epicId;
    case "artifact":
      return payload.epicId ?? null;
    case "approval":
      return payload.epicId ?? null;
    case "interview":
      return payload.epicId;
    case "chat":
      return payload.epicId;
    case "terminal":
      return payload.epicId;
    case "session":
      return null;
  }
}
