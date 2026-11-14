import type { ProvidersListResponse } from "@traycer/protocol/host/provider-schemas";
import { toast } from "sonner";
import type {
  EnvironmentMovePersonalProfile,
  EnvironmentMoveStopResponseV11,
  EnvironmentMoveStopPreviewResponseV12,
} from "@traycer/protocol/host/environment/move-contracts";
import { PersonalLeaveAccounts } from "./personal-leave-accounts";
import { PersonalLeaveSignIn } from "./personal-leave-sign-in";
import {
  personalLeaveAddress,
  type PersonalLeaveAccountStates,
  type PersonalLeaveAccountState,
} from "./personal-leave-model";
import {
  personalLeaveGuidance,
  personalLeaveSignInNotKept,
} from "./personal-leave-copy";
import {
  personalLeaveSignIns,
  personalLeaveSupported,
  usePersonalLeaveAccounts,
  usePersonalLeaveProviders,
  usePersonalLeaveSupport,
} from "./use-personal-leave";
import { providerDisplayName } from "@/lib/provider-ordering";
import { useMemo, useState, type ReactNode } from "react";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import {
  stopManagedFromPreview,
  stopNeedsChoiceFromPreview,
} from "@/components/settings/move/stop-preview-rows";
import {
  stopRowAddress,
  type StopChoiceEntry,
} from "@/components/settings/move/stop-sharing-choices";
import {
  StopSharingSheet,
  type StopPreviewStatus,
} from "@/components/settings/move/stop-sharing-sheet";
import { useEnvironmentMoveStopMutation } from "@/hooks/environment/use-environment-move-stop-mutation";
import { useHostQuery } from "@/hooks/host/use-host-query";
import { useHostMethodSupport } from "@/hooks/host/use-host-supports-method";
import type { HostRpcRegistry } from "@/lib/host";

interface StopSharingSessionProps {
  readonly client: HostClient<HostRpcRegistry> | null;
  readonly hostId: string | null;
  readonly hostName: string;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}

export function StopSharingSession(props: StopSharingSessionProps): ReactNode {
  return props.open ? (
    <OpenStopSharingSession key={props.hostId} {...props} />
  ) : null;
}

function OpenStopSharingSession(props: StopSharingSessionProps): ReactNode {
  const offersLeave = usePersonalLeaveSupport(props.client);
  const accounts = usePersonalLeaveAccounts(props.client);
  const [signingIn, setSigningIn] =
    useState<EnvironmentMovePersonalProfile | null>(null);
  const supported = useHostMethodSupport(
    props.hostId,
    "environment.move.stopPreview",
  );
  const preview = useHostQuery<HostRpcRegistry, "environment.move.stopPreview">(
    {
      cacheKeyIdentity: undefined,
      client: props.client,
      method: "environment.move.stopPreview",
      params: { profileMode: offersLeave ? "keep-personal" : null },
      buildRequest: (params) =>
        params.profileMode !== null && !personalLeaveSupported(props.client)
          ? { profileMode: null }
          : params,
      requiredHostMethodVersion: () =>
        offersLeave
          ? {
              method: "environment.move.stopPreview",
              version: { major: 1, minor: 2 },
            }
          : null,
      options: {
        enabled: props.open && props.hostId !== null && supported === true,
      },
    },
  );
  const stop = useEnvironmentMoveStopMutation(props.client);
  const personalProfiles = offersLeave
    ? (preview.data?.personalProfiles ?? null)
    : null;
  const metadata = usePersonalLeaveProviders(
    props.client,
    personalProfiles !== null,
  );
  // The needs-choice rows the person answered when the host refused the stop
  // as `choices_missing`; null until it does. The preview is read again, and
  // shows the loading state until the new one arrives.
  const [answeredBeforeChange, setAnsweredBeforeChange] =
    useState<ReadonlySet<string> | null>(null);
  const refreshing = answeredBeforeChange !== null && preview.isFetching;
  const previewStatus = refreshing
    ? "loading"
    : stopPreviewStatus(supported, preview);
  const { managed, needsChoice } = useMemo(
    () => stopRowsForMode(preview.data, personalProfiles !== null),
    [preview.data, personalProfiles],
  );
  const changedRows =
    answeredBeforeChange === null
      ? null
      : needsChoice.filter(
          (row) => !answeredBeforeChange.has(stopRowAddress(row)),
        );

  const onOpenChange = (open: boolean): void => {
    if (!open) setAnsweredBeforeChange(null);
    props.onOpenChange(open);
  };

  const onStop = (choices: readonly StopChoiceEntry[]): void => {
    const answered = new Set(needsChoice.map(stopRowAddress));
    stop.mutate(
      {
        profileMode: personalProfiles === null ? null : "keep-personal",
        profileSignIns: personalLeaveSignIns(
          personalProfiles ?? [],
          accounts.states,
        ),
        choices: choices.map((entry) => ({
          kind: entry.kind,
          key: entry.key,
          choice: entry.choice,
        })),
      },
      {
        onSuccess: (data) => {
          if (data.outcome === "choices_missing") {
            setAnsweredBeforeChange(answered);
            void preview.refetch();
            return;
          }
          announceUnkeptSignIns(data, personalProfiles ?? [], accounts.states);
          accounts.committed();
          onOpenChange(false);
        },
        onError: () => {
          if (personalProfiles !== null) void preview.refetch();
        },
      },
    );
  };

  return (
    <>
      <StopSharingSheet
        open={props.open}
        hostName={props.hostName}
        managed={managed}
        needsChoice={needsChoice}
        changedRows={changedRows}
        previewStatus={previewStatus}
        confirmPending={stop.isPending}
        personalAccounts={personalAccountsSection({
          rows: personalProfiles,
          providers: metadata.list?.providers ?? [],
          states: accounts.states,
          pending: stop.isPending,
          onSignIn: setSigningIn,
          onChange: accounts.change,
        })}
        onOpenChange={onOpenChange}
        onStop={onStop}
      />
      {signingIn !== null && personalProfiles !== null ? (
        <PersonalLeaveSignIn
          row={signingIn}
          client={props.client}
          hostId={props.hostId}
          providers={metadata.list?.providers ?? []}
          metadataQuery={metadata.query}
          onSettled={(state) => accounts.change(signingIn, state)}
          onClose={() => setSigningIn(null)}
        />
      ) : null}
    </>
  );
}

function stopPreviewStatus(
  supported: boolean | null,
  preview: { readonly isError: boolean; readonly data: unknown },
): StopPreviewStatus {
  if (supported === false || preview.isError) return "failed";
  if (preview.data !== undefined) return "ready";
  return "loading";
}

function PersonalLeaveGuidance(props: {
  readonly rows: readonly EnvironmentMovePersonalProfile[];
}): ReactNode {
  const providers = [
    ...new Set(
      props.rows
        .filter((row) => row.signIn === "offered")
        .map((row) => row.providerId),
    ),
  ];
  return providers.map((provider) => (
    <p key={provider} className="mb-2 text-ui-xs text-muted-foreground">
      {personalLeaveGuidance(providerDisplayName(provider))}
    </p>
  ));
}

function announceUnkeptSignIns(
  data: EnvironmentMoveStopResponseV11,
  rows: readonly EnvironmentMovePersonalProfile[],
  states: PersonalLeaveAccountStates,
): void {
  const byAddress = new Map(
    rows.map((row) => [personalLeaveAddress(row), row]),
  );
  for (const result of data.profileResults ?? []) {
    if (
      result.signIn !== "sign-in-unavailable" &&
      result.signIn !== "installation-failed"
    )
      continue;
    const address = personalLeaveAddress(result);
    const row = byAddress.get(address);
    if (row !== undefined && states.get(address)?.kind === "signed-in")
      toast(
        personalLeaveSignInNotKept(
          row.label,
          providerDisplayName(row.providerId),
        ),
      );
  }
}

function stopRowsForMode(
  data: EnvironmentMoveStopPreviewResponseV12 | undefined,
  keepPersonal: boolean,
) {
  if (data === undefined) return { managed: [], needsChoice: [] };
  const managed = stopManagedFromPreview(data);
  const needsChoice = stopNeedsChoiceFromPreview(data);
  if (!keepPersonal) return { managed, needsChoice };
  return {
    managed: managed.filter((row) => row.kind !== "managed_profile"),
    needsChoice: needsChoice.filter((row) => row.kind !== "managed_profile"),
  };
}

/** The sheet's empty-state decision needs null, rather than an empty element. */
function personalAccountsSection(props: {
  readonly rows: readonly EnvironmentMovePersonalProfile[] | null;
  readonly providers: ProvidersListResponse["providers"];
  readonly states: PersonalLeaveAccountStates;
  readonly pending: boolean;
  readonly onSignIn: (row: EnvironmentMovePersonalProfile) => void;
  readonly onChange: (
    row: EnvironmentMovePersonalProfile,
    state: PersonalLeaveAccountState | null,
  ) => void;
}): ReactNode {
  if (props.rows === null || props.rows.length === 0) return null;
  return (
    <PersonalLeaveAccounts
      rows={props.rows}
      providers={props.providers}
      states={props.states}
      pending={props.pending}
      guidance={<PersonalLeaveGuidance rows={props.rows} />}
      onSignIn={props.onSignIn}
      onChange={props.onChange}
    />
  );
}
