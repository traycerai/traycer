import { useEffect, useMemo, useRef, useState } from "react";
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
  version: { major: 1, minor: 3 },
};
const STOP = {
  method: "environment.move.stop",
  version: { major: 1, minor: 2 },
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

type PersonalLeaveProfiles = ReadonlyMap<
  string,
  EnvironmentMovePersonalProfile
>;

function matchingProfile(
  profiles: PersonalLeaveProfiles | null,
  row: EnvironmentMovePersonalProfile,
): EnvironmentMovePersonalProfile | null {
  const current = profiles?.get(personalLeaveAddress(row));
  return current?.signIn === row.signIn && current.shared === row.shared
    ? current
    : null;
}

export function usePersonalLeaveAccounts(
  client: HostClient<HostRpcRegistry> | null,
  profiles: readonly EnvironmentMovePersonalProfile[] | null | undefined,
  confirmPending: boolean,
) {
  // Loading has no new sheet to reconcile. Plain Stop has no profile rows.
  const shown = useMemo<PersonalLeaveProfiles | null>(
    () =>
      profiles === undefined
        ? null
        : new Map(
            (profiles ?? []).map((row) => [personalLeaveAddress(row), row]),
          ),
    [profiles],
  );
  const [sheet, setSheet] = useState<{
    readonly profiles: PersonalLeaveProfiles | null;
    readonly states: PersonalLeaveAccountStates;
  }>(() => ({ profiles: shown, states: new Map() }));
  if (shown !== null && shown !== sheet.profiles) {
    const states = new Map<string, PersonalLeaveAccountState>();
    for (const [address, state] of sheet.states) {
      const row = sheet.profiles?.get(address);
      if (row !== undefined && matchingProfile(shown, row) !== null)
        states.set(address, state);
    }
    setSheet({ profiles: shown, states });
  }
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
  useEffect(() => {
    if (confirmPending) return;
    for (const [address, signIn] of held.current) {
      const decision = sheet.states.get(address);
      if (
        decision?.kind === "signed-in" &&
        decision.admissionId === signIn.admissionId
      )
        continue;
      held.current.delete(address);
      void cancelHeld({
        providerId: signIn.providerId,
        profileId: signIn.admissionId,
        holderId: null,
      }).catch(() => {});
    }
  }, [cancelHeld, confirmPending, sheet.states]);
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
    setSheet((current) => {
      if (matchingProfile(current.profiles, row) === null) return current;
      const next = new Map(current.states);
      if (state === null) next.delete(address);
      else next.set(address, state);
      return { profiles: current.profiles, states: next };
    });
  };
  return {
    states: sheet.states,
    change,
    matchingProfile: (row: EnvironmentMovePersonalProfile) =>
      matchingProfile(sheet.profiles, row),
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
    .map((row) => ({
      providerId: row.providerId,
      profileId: row.profileId,
      signIn: signInChoiceOf(states.get(personalLeaveAddress(row))),
    }));
}

/** Only a pressed Skip is `skip`; a row nobody answered is `untouched`. */
function signInChoiceOf(
  state: PersonalLeaveAccountState | undefined,
): EnvironmentMoveProfileSignInChoice["signIn"] {
  if (state?.kind === "signed-in")
    return { kind: "signed-in", admissionId: state.admissionId };
  if (state?.kind === "skip") return { kind: "skip" };
  return { kind: "untouched" };
}
