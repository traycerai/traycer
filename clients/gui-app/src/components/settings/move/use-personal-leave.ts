import { useEffect, useRef, useState } from "react";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import {
  HostMethodVersionUnsatisfiedError,
  negotiatedVersionMeetsRequirement,
  type RequiredHostMethodVersion,
} from "@traycer-clients/shared/host-transport/host-messenger";
import type {
  EnvironmentMovePersonalProfile,
  EnvironmentMoveProfileSignInChoice,
} from "@traycer/protocol/host/environment/move-contracts";
import {
  personalLeaveAddress,
  type PersonalLeaveAccountState,
  type PersonalLeaveAccountStates,
} from "./personal-leave-model";
import { useCachedProvidersList } from "@/hooks/providers/use-cached-providers-list";
import { useProvidersCancelLoginForClient } from "@/hooks/providers/use-providers-cancel-login-mutation";
import { useHostQuery } from "@/hooks/host/use-host-query";
import {
  useHostNegotiatedMethodVersion,
  type NegotiatedMethodVersion,
} from "@/hooks/host/use-host-negotiated-method-version";
import { readHostMethodSchemaVersion } from "@/hooks/host/use-host-supports-method";
import type { HostRpcRegistry } from "@/lib/host";

const PREVIEW = {
  method: "environment.move.stopPreview",
  version: { major: 1, minor: 2 },
};
const STOP = {
  method: "environment.move.stop",
  version: { major: 1, minor: 1 },
};
const START = {
  method: "providers.startLogin",
  version: { major: 1, minor: 5 },
};
const AWAIT = {
  method: "providers.awaitLogin",
  version: { major: 2, minor: 4 },
};

function supports(
  version: NegotiatedMethodVersion,
  floor: RequiredHostMethodVersion,
): boolean {
  return (
    version !== false &&
    negotiatedVersionMeetsRequirement(version ?? undefined, floor)
  );
}

export function requirePersonalLeaveSupport(
  client: HostClient<HostRpcRegistry> | null,
): void {
  const hostId = client?.getActiveHostId() ?? null;
  for (const floor of [PREVIEW, STOP, START, AWAIT]) {
    const negotiated = readHostMethodSchemaVersion(hostId, floor.method);
    if (negotiatedVersionMeetsRequirement(negotiated ?? undefined, floor))
      continue;
    throw new HostMethodVersionUnsatisfiedError({
      requirement: floor,
      negotiated: negotiated ?? undefined,
      requestId: "",
      method: "environment.move.stopPreview",
      hostId: hostId ?? "",
    });
  }
}

export function usePersonalLeaveSupport(
  client: HostClient<HostRpcRegistry> | null,
): boolean {
  const preview = useHostNegotiatedMethodVersion(
    client,
    "environment.move.stopPreview",
  );
  const stop = useHostNegotiatedMethodVersion(client, "environment.move.stop");
  const start = useHostNegotiatedMethodVersion(client, "providers.startLogin");
  const awaitLogin = useHostNegotiatedMethodVersion(
    client,
    "providers.awaitLogin",
  );
  return (
    supports(preview, PREVIEW) &&
    supports(stop, STOP) &&
    supports(start, START) &&
    supports(awaitLogin, AWAIT)
  );
}

export function usePersonalLeaveProviders(
  client: HostClient<HostRpcRegistry> | null,
  enabled: boolean,
) {
  const source = enabled ? client : null;
  const list = useCachedProvidersList(source);
  const query = useHostQuery<HostRpcRegistry, "providers.list">({
    cacheKeyIdentity: undefined,
    client: source,
    method: "providers.list",
    params: { native: null },
    options: {
      // Only an explicit Retry asks again after a failed metadata read.
      enabled: (entry) =>
        enabled && entry.state.data === undefined && entry.state.error === null,
      subscribed: enabled,
      notifyOnChangeProps: "all",
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
      staleTime: Infinity,
    },
  });
  return { list, query };
}

export function usePersonalLeaveAccounts(
  client: HostClient<HostRpcRegistry> | null,
) {
  const [states, setStates] = useState<PersonalLeaveAccountStates>(
    () => new Map(),
  );
  const cancel = useProvidersCancelLoginForClient(client);
  const held = useRef(
    new Map<
      string,
      {
        readonly providerId: EnvironmentMovePersonalProfile["providerId"];
        readonly admissionId: string;
      }
    >(),
  );
  const cancelHeld = cancel.mutateAsync;
  useEffect(() => {
    const signIns = held.current;
    return () => {
      for (const signIn of signIns.values()) {
        void cancelHeld({
          providerId: signIn.providerId,
          profileId: signIn.admissionId,
          holderId: null,
        }).catch(() => {});
      }
      signIns.clear();
    };
  }, [cancelHeld]);
  const change = (
    row: EnvironmentMovePersonalProfile,
    state: PersonalLeaveAccountState | null,
  ): void => {
    const address = personalLeaveAddress(row);
    if (state?.kind === "signed-in")
      held.current.set(address, {
        providerId: row.providerId,
        admissionId: state.admissionId,
      });
    setStates((current) => {
      const next = new Map(current);
      if (state === null) next.delete(address);
      else next.set(address, state);
      return next;
    });
  };
  return {
    states,
    change,
    committed: (): void => {
      held.current.clear();
    },
  };
}

export function personalLeaveSignIns(
  rows: readonly EnvironmentMovePersonalProfile[],
  states: PersonalLeaveAccountStates,
): EnvironmentMoveProfileSignInChoice[] {
  return rows
    .filter((row) => row.signIn === "offered")
    .map((row) => {
      const state = states.get(personalLeaveAddress(row));
      return {
        providerId: row.providerId,
        profileId: row.profileId,
        signIn:
          state?.kind === "signed-in"
            ? { kind: "signed-in", admissionId: state.admissionId }
            : { kind: "skip" },
      };
    });
}
