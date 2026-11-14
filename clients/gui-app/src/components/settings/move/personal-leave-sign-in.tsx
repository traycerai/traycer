import { useEffect, type ReactNode } from "react";
import type { UseQueryResult } from "@tanstack/react-query";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type {
  HostRpcError,
  ResponseOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import type { EnvironmentMovePersonalProfile } from "@traycer/protocol/host/environment/move-contracts";
import type { ProvidersListResponse } from "@traycer/protocol/host/provider-schemas";
import {
  AddProviderProfileDialog,
  AddProfileFailureStep,
  DuplicateAccountNotice,
  ProfileAccountRow,
  type ProviderTargetLoginControls,
} from "@/components/settings/panels/add-provider-profile-dialog";
import {
  classifyProfileAwaitResult,
  type ProviderTargetLoginResult,
} from "@/components/settings/panels/use-provider-profile-login-flow";
import {
  ADD_PROFILE_DIALOG_TITLE,
  REMOVED_PROFILE_PIN_TEXT,
  signedInAsText,
} from "@/components/providers/profile-sync-copy";
import { PERSONAL_LEAVE_UNAVAILABLE } from "./personal-leave-copy";
import type { PersonalLeaveAccountState } from "./personal-leave-model";
import { useReactiveLocalHostId } from "@/hooks/host/use-reactive-local-host-id";
import { Button } from "@/components/ui/button";
import { MutedAgentSpinner } from "@/components/ui/agent-spinning-dots";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { PROVIDER_STATE_UNREADABLE_COPY } from "@/lib/providers/provider-settings-unreadable-error";
import type { HostRpcRegistry } from "@/lib/host";

export function PersonalLeaveSignIn(props: {
  readonly row: EnvironmentMovePersonalProfile;
  readonly client: HostClient<HostRpcRegistry> | null;
  readonly hostId: string | null;
  readonly providers: ProvidersListResponse["providers"];
  readonly metadataQuery: UseQueryResult<
    ResponseOfMethod<HostRpcRegistry, "providers.list">,
    HostRpcError
  >;
  readonly onSettled: (state: PersonalLeaveAccountState) => void;
  readonly onClose: () => void;
}): ReactNode {
  const localHostId = useReactiveLocalHostId();
  const provider = props.providers.find(
    (entry) => entry.providerId === props.row.providerId,
  );
  if (provider === undefined)
    return (
      <Dialog
        open
        onOpenChange={(open) => {
          if (!open) props.onClose();
        }}
      >
        <DialogContent layout="banded" aria-describedby={undefined}>
          <DialogHeader>
            <DialogTitle>{ADD_PROFILE_DIALOG_TITLE}</DialogTitle>
          </DialogHeader>
          <DialogFooter>
            {props.metadataQuery.isFetching &&
            !props.metadataQuery.isFetched ? (
              <MutedAgentSpinner />
            ) : (
              <>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={props.metadataQuery.isFetching}
                  onClick={() => {
                    void props.metadataQuery.refetch();
                  }}
                >
                  {props.metadataQuery.isFetching ? (
                    <MutedAgentSpinner />
                  ) : null}
                  Retry
                </Button>
                <p className="text-ui-sm text-muted-foreground">
                  {PROVIDER_STATE_UNREADABLE_COPY}
                </p>
              </>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  return (
    <AddProviderProfileDialog
      key={`${props.row.providerId}:${props.row.profileId}`}
      state={provider}
      client={props.client}
      isLocalHost={props.hostId !== null && props.hostId === localHostId}
      open
      target={{ kind: "leave-to-local", profileId: props.row.profileId }}
      targetResult={(result, controls) => (
        <PersonalLeaveOutcome
          row={props.row}
          result={result}
          controls={controls}
          onSettled={props.onSettled}
          onClose={props.onClose}
        />
      )}
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
      onFailedAttempt={() => {}}
      onProfileCreated={() => {}}
    />
  );
}

function PersonalLeaveOutcome(props: {
  readonly row: EnvironmentMovePersonalProfile;
  readonly result: ProviderTargetLoginResult;
  readonly controls: ProviderTargetLoginControls;
  readonly onSettled: (state: PersonalLeaveAccountState) => void;
  readonly onClose: () => void;
}): ReactNode {
  const { result, row, onSettled, onClose } = props;
  const settled = leaveOutcomeState(result, row.profileId);
  useEffect(() => {
    const state = leaveOutcomeState(result, row.profileId);
    if (state === null) return;
    onSettled(state);
    onClose();
  }, [result, row.profileId, onSettled, onClose]);
  if (settled !== null) return null;
  if (result.kind === "target-refused")
    return (
      <LeaveRefusal
        removed={result.targetRefusal === "target-removed"}
        onDone={props.onClose}
      />
    );
  if (result.profileOutcome?.kind === "target-refused")
    return (
      <LeaveRefusal
        removed={result.profileOutcome.reason === "target-removed"}
        onDone={props.onClose}
      />
    );
  if (result.profileOutcome === null)
    return (
      <LegacyLeaveOutcome
        row={props.row}
        result={result}
        controls={props.controls}
        onClose={props.onClose}
      />
    );
  return (
    <AddProfileFailureStep
      providerId={props.row.providerId}
      message="Sign-in did not finish. Retry when you are ready."
      refusal={null}
      onCancel={props.onClose}
      onRetry={props.controls.onSignInWithAnother}
    />
  );
}

function leaveOutcomeState(
  result: ProviderTargetLoginResult,
  profileId: string,
): PersonalLeaveAccountState | null {
  if (result.kind !== "target-outcome") return null;
  const outcome = result.profileOutcome;
  if (
    outcome?.kind === "staged-for-leave" &&
    outcome.profileId === profileId &&
    result.admissionId !== null
  )
    return { kind: "signed-in", admissionId: result.admissionId };
  if (
    outcome?.kind === "account-mismatch" ||
    outcome?.kind === "account-unproven"
  )
    return { kind: outcome.kind };
  return null;
}

function LeaveRefusal(props: {
  readonly removed: boolean;
  readonly onDone: () => void;
}): ReactNode {
  return (
    <>
      <p className="px-5 pb-5 text-ui-sm text-muted-foreground">
        {props.removed ? REMOVED_PROFILE_PIN_TEXT : PERSONAL_LEAVE_UNAVAILABLE}
      </p>
      <DialogFooter>
        <Button type="button" size="sm" onClick={props.onDone}>
          Done
        </Button>
      </DialogFooter>
    </>
  );
}

function LegacyLeaveOutcome(props: {
  readonly row: EnvironmentMovePersonalProfile;
  readonly result: Extract<
    ProviderTargetLoginResult,
    { readonly kind: "target-outcome" }
  >;
  readonly controls: ProviderTargetLoginControls;
  readonly onClose: () => void;
}): ReactNode {
  const resolution = classifyProfileAwaitResult(
    props.result,
    props.result.admissionId,
  );
  if (resolution.kind !== "authenticated" || resolution.payload === null)
    return (
      <AddProfileFailureStep
        providerId={props.row.providerId}
        message="Sign-in did not finish. Retry when you are ready."
        refusal={props.result.refusal ?? null}
        onCancel={props.onClose}
        onRetry={props.controls.onSignInWithAnother}
      />
    );
  const { profile, existingProfileId } = resolution.payload;
  return (
    <>
      <div className="px-5 pb-5">
        {existingProfileId === null ? (
          <ProfileAccountRow
            providerId={props.row.providerId}
            profile={profile}
          />
        ) : (
          <DuplicateAccountNotice profile={profile} />
        )}
      </div>
      <DialogFooter>
        {existingProfileId !== null ? (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={props.controls.onSignInWithAnother}
          >
            Sign in again
          </Button>
        ) : (
          <p className="text-ui-sm text-muted-foreground">
            {signedInAsText(profile.label)}
          </p>
        )}
        <Button type="button" size="sm" onClick={props.onClose}>
          Done
        </Button>
      </DialogFooter>
    </>
  );
}
