import type { ProvidersListResponse } from "@traycer/protocol/host/provider-schemas";
import { toast } from "sonner";
import {
  matchesStopPersonalBinding,
  type EnvironmentMovePersonalProfile,
  type EnvironmentMoveStopResponseV11,
  type EnvironmentMoveStopPersonalBinding,
  type EnvironmentMoveStopPreviewResponseV13,
  type EnvironmentMoveStopPreviewResponseV14,
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
import { useEffect, useId, useMemo, useState, type ReactNode } from "react";
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
import { STOP_OWNERSHIP_PREVIEW_FLOOR } from "./stop-sharing-versions";
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
  readonly expectedPersonalBinding?: EnvironmentMoveStopPersonalBinding | null;
  readonly ownershipPreviewState?: "refused" | "recovered";
}

export function StopSharingSession(props: StopSharingSessionProps): ReactNode {
  return props.open ? (
    <OpenStopSharingSession key={props.hostId} {...props} />
  ) : null;
}

function OpenStopSharingSession(props: StopSharingSessionProps): ReactNode {
  const [signingIn, setSigningIn] =
    useState<EnvironmentMovePersonalProfile | null>(null);
  const expected = props.expectedPersonalBinding ?? null;
  const sheet = useStopSheetPreview(props, expected);
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
    if (previewStatus !== "ready") return;
    const answered = new Set(needsChoice.map(stopRowAddress));
    stop.mutate(
      {
        profileMode: personalProfiles === null ? null : "keep-personal",
        sheetDigest,
        expectedPersonalBinding:
          expected === null ? null : sheet.personalBinding,
        requireUnreadableOwnership: sheet.ownershipUnreadable,
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
            if (expected === null) sheet.replace(data.preview);
            else void sheet.refreshAfterRefusal();
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
          if (
            personalProfiles === null &&
            sheetDigest === null &&
            expected === null
          )
            return;
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
        ownershipUnreadable={sheet.ownershipUnreadable}
        retryOwnershipPreview={
          expected === null
            ? undefined
            : () => {
                void sheet.refreshAfterRefusal();
              }
        }
        confirmPending={stop.isPending}
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
  props: StopSharingSessionProps,
  expected: EnvironmentMoveStopPersonalBinding | null,
) {
  const { client, hostId, onOpenChange, ownershipPreviewState } = props;
  const sessionId = useId();
  const [observed, setObserved] = useState({
    ownershipPreviewState,
    revision: 0,
  });
  let revision = observed.revision;
  if (
    expected !== null &&
    observed.ownershipPreviewState !== ownershipPreviewState
  ) {
    revision += 1;
    setObserved({ ownershipPreviewState, revision });
  }
  const offersLeave = usePersonalLeaveSupport(client);
  const supported = useHostMethodSupport(
    hostId,
    "environment.move.stopPreview",
  );
  const preview = useHostQuery<HostRpcRegistry, "environment.move.stopPreview">(
    {
      // Each ownership transition and guarded retry needs its own read.
      cacheKeyIdentity: expected === null ? undefined : [sessionId, revision],
      client,
      method: "environment.move.stopPreview",
      params: {
        profileMode: offersLeave ? "keep-personal" : null,
        expectedPersonalBinding: expected,
      },
      preflight: () => {
        if (offersLeave) requirePersonalLeaveSupport(client);
      },
      requiredHostMethodVersion: () => {
        if (expected !== null) return STOP_OWNERSHIP_PREVIEW_FLOOR;
        return offersLeave
          ? {
              method: "environment.move.stopPreview",
              version: { major: 1, minor: 3 },
            }
          : null;
      },
      options: {
        enabled: hostId !== null && supported === true,
        ...(expected === null ? {} : { refetchOnMount: "always" }),
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
    if (expected !== null) {
      setObserved((current) => ({
        ...current,
        revision: current.revision + 1,
      }));
      return;
    }
    setRefreshStatus("loading");
    const fresh = await preview.refetch();
    if (fresh.isSuccess) {
      replace(fresh.data);
      setRefreshStatus(null);
    } else {
      setRefreshStatus("failed");
    }
  };
  const data = preview.data;
  const bindingChanged =
    expected !== null &&
    !preview.isError &&
    !preview.isFetching &&
    !preview.isPlaceholderData &&
    data !== undefined &&
    !matchesStopPersonalBinding(expected, data.personalBinding);
  useEffect(() => {
    if (bindingChanged) onOpenChange(false);
  }, [bindingChanged, onOpenChange]);

  const guardedPending =
    expected !== null &&
    !preview.isError &&
    (preview.isFetching ||
      preview.isPlaceholderData ||
      bindingChanged ||
      (data !== undefined &&
        data.ownershipUnreadable !== (ownershipPreviewState === "refused")));
  const guardedPreview =
    expected === null || guardedPending || preview.isError ? undefined : data;
  const shown =
    expected === null ? (replacement?.preview ?? data) : guardedPreview;
  let status = refreshStatus ?? stopPreviewStatus(supported, preview);
  if (expected === null && refreshStatus === null && replacement !== null)
    status = "ready";
  if (guardedPending) status = "loading";
  return {
    shown,
    sheetDigest: shown?.sheetDigest ?? null,
    personalBinding: guardedPreview?.personalBinding ?? null,
    ownershipUnreadable: guardedPreview?.ownershipUnreadable === true,
    personalProfiles: offersLeave ? (shown?.personalProfiles ?? null) : null,
    revision: expected === null ? (replacement?.revision ?? 0) : revision,
    status,
    refreshing: refreshStatus === "loading" || guardedPending,
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
  if (supported === false || preview.isError) return "failed";
  if (preview.data !== undefined) return "ready";
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
