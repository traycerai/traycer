import type { ProvidersListResponse } from "@traycer/protocol/host/provider-schemas";
import { toast } from "sonner";
import type {
  EnvironmentMovePersonalProfile,
  EnvironmentMoveStopResponseV11,
  EnvironmentMoveStopPreviewResponseV13,
  EnvironmentMoveStopPreviewResponseV14,
} from "@traycer/protocol/host/environment/move-contracts";
import { PersonalLeaveAccounts } from "./personal-leave-accounts";
import { PersonalLeaveSignIn } from "./personal-leave-sign-in";
import {
  personalLeaveAddress,
  type PersonalLeaveAccountStates,
  type PersonalLeaveAccountState,
} from "./personal-leave-model";
import {
  PERSONAL_LEAVE_GUIDANCE,
  personalLeaveSignInNotKept,
} from "./personal-leave-copy";
import {
  personalLeaveSignIns,
  requirePersonalLeaveSupport,
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
  readonly confirmBlocked?: boolean | undefined;
  readonly onOpenChange: (open: boolean) => void;
}

export function StopSharingSession(props: StopSharingSessionProps): ReactNode {
  return props.open ? (
    <OpenStopSharingSession key={props.hostId} {...props} />
  ) : null;
}

function OpenStopSharingSession(props: StopSharingSessionProps): ReactNode {
  const [signingIn, setSigningIn] =
    useState<EnvironmentMovePersonalProfile | null>(null);
  const sheet = useStopSheetPreview(props.client, props.hostId);
  const { shown, sheetDigest, personalProfiles, status: previewStatus } = sheet;
  const stop = useEnvironmentMoveStopMutation(props.client);
  const accounts = usePersonalLeaveAccounts(
    props.client,
    previewStatus === "ready" ? personalProfiles : undefined,
    stop.isPending || sheet.refreshing,
  );
  const signInRow =
    signingIn === null ? null : accounts.matchingProfile(signingIn);
  if (signingIn !== null && previewStatus === "ready" && signInRow === null)
    setSigningIn(null);
  const metadata = usePersonalLeaveProviders(
    props.client,
    personalProfiles !== null,
  );
  const providers = metadata.list?.providers ?? [];
  // The needs-choice rows the person answered when the host refused the stop
  // as `choices_missing`; null until it does. The preview is read again, and
  // shows the loading state until the new one arrives.
  const [answeredBeforeChange, setAnsweredBeforeChange] =
    useState<ReadonlySet<string> | null>(null);
  const { managed, needsChoice } = useMemo(
    () => stopRowsForMode(shown, personalProfiles !== null),
    [shown, personalProfiles],
  );
  const changedRows =
    answeredBeforeChange === null
      ? null
      : needsChoice.filter(
          (row) => !answeredBeforeChange.has(stopRowAddress(row)),
        );

  const onOpenChange = (open: boolean): void => {
    if (!open) {
      setAnsweredBeforeChange(null);
    }
    props.onOpenChange(open);
  };

  const onStop = (choices: readonly StopChoiceEntry[]): void => {
    const answered = new Set(needsChoice.map(stopRowAddress));
    stop.mutate(
      {
        profileMode: personalProfiles === null ? null : "keep-personal",
        sheetDigest,
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
          if (data.outcome === "sheet_changed") {
            setAnsweredBeforeChange(answered);
            sheet.replace(data.preview);
            return;
          }
          if (data.outcome === "choices_missing") {
            setAnsweredBeforeChange(answered);
            void sheet.refreshAfterRefusal();
            return;
          }
          announceUnkeptSignIns(data, personalProfiles ?? [], accounts.states);
          accounts.committed();
          onOpenChange(false);
        },
        onError: () => {
          if (personalProfiles === null && sheetDigest === null) return;
          // Per-mutate callbacks precede the mutation observer's listeners:
          // raise the gate before the settled mutation can enable Stop.
          void sheet.refreshAfterRefusal();
        },
      },
    );
  };

  return (
    <>
      <StopSharingSheet
        key={`${sheet.revision}:${sheetDigest ?? ""}`}
        open={props.open}
        hostName={props.hostName}
        managed={managed}
        needsChoice={needsChoice}
        changedRows={changedRows}
        previewStatus={previewStatus}
        confirmPending={stop.isPending}
        confirmBlocked={props.confirmBlocked === true}
        personalAccounts={personalAccountsSection({
          rows: personalProfiles,
          providers,
          states: accounts.states,
          pending: stop.isPending,
          onSignIn: setSigningIn,
          onChange: accounts.change,
        })}
        onOpenChange={onOpenChange}
        onStop={onStop}
      />
      {signInRow !== null ? (
        <PersonalLeaveSignIn
          row={signInRow}
          client={props.client}
          hostId={props.hostId}
          providers={providers}
          metadataQuery={metadata.query}
          onSettled={(state) => accounts.change(signInRow, state)}
          onClose={() => setSigningIn(null)}
        />
      ) : null}
    </>
  );
}

function useStopSheetPreview(
  client: HostClient<HostRpcRegistry> | null,
  hostId: string | null,
) {
  const offersLeave = usePersonalLeaveSupport(client);
  const supported = useHostMethodSupport(
    hostId,
    "environment.move.stopPreview",
  );
  const preview = useHostQuery<HostRpcRegistry, "environment.move.stopPreview">(
    {
      cacheKeyIdentity: undefined,
      client,
      method: "environment.move.stopPreview",
      params: { profileMode: offersLeave ? "keep-personal" : null },
      preflight: () => {
        if (offersLeave) requirePersonalLeaveSupport(client);
      },
      requiredHostMethodVersion: () =>
        offersLeave
          ? {
              method: "environment.move.stopPreview",
              version: { major: 1, minor: 3 },
            }
          : null,
      options: {
        enabled: hostId !== null && supported === true,
      },
    },
  );
  const [replacement, setReplacement] = useState<{
    readonly revision: number;
    readonly preview: EnvironmentMoveStopPreviewResponseV14;
  } | null>(null);
  const [refreshStatus, setRefreshStatus] = useState<
    "loading" | "failed" | null
  >(null);
  const replace = (fresh: EnvironmentMoveStopPreviewResponseV14): void => {
    setReplacement((current) => ({
      revision: (current?.revision ?? 0) + 1,
      preview: fresh,
    }));
  };
  const refreshAfterRefusal = async (): Promise<void> => {
    setRefreshStatus("loading");
    const fresh = await preview.refetch();
    if (fresh.isSuccess) {
      replace(fresh.data);
      setRefreshStatus(null);
    } else {
      setRefreshStatus("failed");
    }
  };
  const shown = replacement?.preview ?? preview.data;
  return {
    shown,
    sheetDigest: shown?.sheetDigest ?? null,
    personalProfiles: offersLeave ? (shown?.personalProfiles ?? null) : null,
    revision: replacement?.revision ?? 0,
    status:
      refreshStatus ??
      (replacement === null ? stopPreviewStatus(supported, preview) : "ready"),
    refreshing: refreshStatus === "loading",
    replace,
    refreshAfterRefusal,
  };
}

function stopPreviewStatus(
  supported: boolean | null,
  preview: {
    readonly isError: boolean;
    readonly data: unknown;
  },
): StopPreviewStatus {
  if (supported === false) return "failed";
  if (preview.data !== undefined) return "ready";
  if (preview.isError) return "failed";
  return "loading";
}

function PersonalLeaveGuidance(props: {
  readonly rows: readonly EnvironmentMovePersonalProfile[];
}): ReactNode {
  return props.rows.some((row) => row.signIn === "offered") ? (
    <p className="mb-2 text-ui-xs text-muted-foreground">
      {PERSONAL_LEAVE_GUIDANCE}
    </p>
  ) : null;
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
          row.shared,
        ),
      );
  }
}

function stopRowsForMode(
  data: EnvironmentMoveStopPreviewResponseV13 | undefined,
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
