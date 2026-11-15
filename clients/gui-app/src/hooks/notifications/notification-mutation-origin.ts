import { useState } from "react";
import type { MutateOptions, UseMutationResult } from "@tanstack/react-query";
import type { EnvironmentCloud } from "@traycer-clients/shared/environment/environment-cloud";
import { HostRequestAbortedError } from "@traycer-clients/shared/host-transport/host-messenger";

interface NotificationWriteOrigin {
  readonly cloud: EnvironmentCloud | null;
}

export function notificationWriteIsCurrent(
  origin: NotificationWriteOrigin,
): boolean {
  return origin.cloud === null || origin.cloud.onOriginSignIn();
}

export function requireNotificationWriteOrigin(
  origin: NotificationWriteOrigin,
  method: string,
): void {
  if (notificationWriteIsCurrent(origin)) return;
  throw new HostRequestAbortedError({
    message: "",
    requestId: "notification-sign-in-ended",
    method,
    mayHaveDispatched: false,
  });
}

function originOptions<Data, Error, Variables, Context>(
  options: MutateOptions<Data, Error, Variables, Context> | undefined,
  origin: NotificationWriteOrigin,
): MutateOptions<Data, Error, Variables, Context> | undefined {
  if (options === undefined) return undefined;
  return {
    onSuccess: (...args) => {
      if (notificationWriteIsCurrent(origin)) options.onSuccess?.(...args);
    },
    onError: (...args) => {
      if (notificationWriteIsCurrent(origin)) options.onError?.(...args);
    },
    onSettled: (...args) => {
      if (notificationWriteIsCurrent(origin)) options.onSettled?.(...args);
    },
  };
}

/** Capture before TanStack's first await; every press has its own request identity. */
export function useNotificationMutationOrigin<
  Captured extends NotificationWriteOrigin,
>(capture: () => Captured) {
  const [origins] = useState(() => new WeakMap<object, Captured>());
  const contextOf = (variables: object): Captured => {
    const context = origins.get(variables);
    if (context === undefined)
      throw new Error("The settings request was refused.");
    return context;
  };
  const atPress = <Variables extends object>(variables: Variables) => {
    const pressed = { ...variables };
    const origin = capture();
    origins.set(pressed, origin);
    return { pressed, origin };
  };
  function wrap<Data, Error, Variables extends object, Context>(
    mutation: UseMutationResult<Data, Error, Variables, Context>,
  ): UseMutationResult<Data, Error, Variables, Context> {
    return {
      ...mutation,
      mutate: (variables, options) => {
        const { pressed, origin } = atPress(variables);
        mutation.mutate(pressed, originOptions(options, origin));
      },
      mutateAsync: (variables, options) => {
        const { pressed, origin } = atPress(variables);
        return mutation.mutateAsync(pressed, originOptions(options, origin));
      },
    };
  }
  return { contextOf, wrap };
}
