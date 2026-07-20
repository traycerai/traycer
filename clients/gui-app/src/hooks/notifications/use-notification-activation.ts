import { useCallback } from "react";
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

export interface NotificationActivationInput {
  readonly payload: NotificationPayload;
  readonly receivedAt: number;
  readonly onActivated: (() => void) | null;
}

export interface NotificationActivationController {
  readonly activate: (input: NotificationActivationInput) => void;
  readonly isPending: boolean;
}

interface NotificationPreflightVariables extends NotificationActivationInput {
  readonly epicId: string;
}

/**
 * Opens feed-backed notifications through the default host scope.
 *
 * `epic.listCollaborators` is intentionally used after routing because the
 * host repairs local collaboration metadata from that authoritative response.
 * Routing happens synchronously on click so the surface does not feel inert
 * while the repair request is in flight. If this hook is mounted outside a
 * host runtime, activation falls back to pure routing so existing
 * browser-only tests and shells keep working.
 */
export function useNotificationActivation(): NotificationActivationController {
  const binding = useHostBinding();
  const client = binding?.hostClient ?? null;
  const navigate = useNavigate();
  const { mutate, isPending } = useHostMutation<
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
        variables.onActivated?.();
      },
      onError: (error) => {
        toastFromHostError(error, "Couldn't open the shared epic.");
      },
    },
  });

  const activate = useCallback(
    (input: NotificationActivationInput) => {
      const epicId = getNotificationPreflightEpicId(input.payload);
      routeNotification(navigate, input.payload, input.receivedAt);
      if (epicId === null || binding === null) {
        input.onActivated?.();
        return;
      }
      mutate({ ...input, epicId });
    },
    [binding, mutate, navigate],
  );

  return { activate, isPending };
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
