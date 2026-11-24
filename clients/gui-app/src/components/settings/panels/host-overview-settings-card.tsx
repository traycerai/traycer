import {
  configurationRoleOf,
  mayChangeConfiguration,
} from "@/components/settings/environment/configuration-source";
import { TeamReadFailed } from "@/components/settings/environment/team-read-failed";
import { useTeamComputerClaim } from "@/hooks/auth/use-team-computers";
import { TeamGiveDialog } from "@/components/settings/panels/team-give-dialog";
import { ClaimRunningWork } from "@/components/settings/team/claim-running-work";
import { useAuthStore } from "@/stores/auth/auth-store";
import type { HostOwnerPrincipal } from "@traycer/protocol/host/host-status";
import { useEnvironmentListQuery } from "@/hooks/bots/use-environment-list-query";
import { Button } from "@/components/ui/button";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import type { EnvironmentDescriptorV11 } from "@traycer/protocol/host/environment/contracts";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { EnvironmentHostBinding } from "@traycer/protocol/host/environment/contracts";
import type { EnvironmentStatusResponseV11 } from "@traycer/protocol/host/environment-schemas";
import { OverviewCardDetailsDialog } from "@/components/settings/details/overview-card-details-line";
import type { OverviewCardLineProps } from "@/components/settings/environment/overview-card-line-props";
import {
  isStaleLocalPick,
  localPickerRow,
} from "@/components/settings/environment/environment-picker-model";
import { MoveProgressLine } from "@/components/settings/move/move-progress-line";
import { StopSharingSession } from "@/components/settings/move/stop-sharing-session";
import {
  hostSettingsRowModel,
  type HostSettingsRowModel,
  type HostSettingsRowOption,
} from "@/components/settings/panels/host-overview-settings-card-model";
import { HOST_OVERVIEW } from "@/components/settings/panels/host-overview.definitions";
import { SettingsRow } from "@/components/settings/settings-row";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import {
  useEnvironmentHostReadQuery,
  type EnvironmentHostRead,
} from "@/hooks/bots/use-environment-host-read-query";
import { readsHostBindingsFromPool } from "@/hooks/bots/use-host-environment-bindings-query";
import { useEnvironmentStatusRead } from "@/hooks/environment/use-environment-reads";
import {
  useHostNegotiatedMethodVersions,
  type NegotiatedMethodVersion,
} from "@/hooks/host/use-host-negotiated-method-version";
import { useHostMethodSupport } from "@/hooks/host/use-host-supports-method";
import type { HostRpcRegistry } from "@/lib/host";
import {
  environmentPickValue,
  PERSONAL_PICK,
  type EnvironmentPick,
} from "@/lib/settings-environment-pages";
import { useMoveSheetStore } from "@/stores/settings/move-sheet-store";
import { useSettingsEnvironmentPickStore } from "@/stores/settings/settings-environment-pick-store";

/** A give whose start answered: the team it names and the line its receipt shows. */
export interface StartedGive {
  readonly teamId: string;
  readonly line: string;
}

/**
 * The give and claim receipt line. It is held above the card, because the owner
 * change restarts the computer and the card unmounts while the host is away.
 */
export interface OwnershipReceipt {
  readonly line: string | null;
  readonly show: (line: string) => void;
  readonly giveStarted: (give: StartedGive) => void;
}

type OpenSettingsAction =
  | { readonly kind: "stop"; readonly client: HostClient<HostRpcRegistry> }
  | {
      readonly kind: "give";
      readonly client: HostClient<HostRpcRegistry>;
      readonly currentEnvironmentId: string | null;
      readonly team: EnvironmentDescriptorV11;
    }
  | { readonly kind: "claim"; readonly environmentId: string };

interface HostOverviewSettingsCardProps {
  readonly client: HostClient<HostRpcRegistry> | null;
  readonly hostId: string;
  readonly hostName: string;
  readonly status: EnvironmentStatusResponseV11 | null;
  readonly binding: EnvironmentHostBinding | null;
  readonly owner: HostOwnerPrincipal | null;
  readonly isLocalMachine: boolean;
  readonly receipt: OwnershipReceipt;
  readonly hidden?: boolean;
  readonly statusUnsupported?: boolean;
}

/** The named host's settings place, above the Overview's tabs. */
export function HostOverviewSettingsCard(
  props: HostOverviewSettingsCardProps,
): ReactNode {
  const { client, hidden, hostId, hostName, receipt, status } = props;
  const openMoveSheet = useMoveSheetStore((state) => state.openSheet);
  const [action, setAction] = useState<OpenSettingsAction | null>(null);
  const [details, setDetails] = useState<OverviewCardLineProps | null>(null);
  const hostIds = useMemo(() => [hostId], [hostId]);
  const row = useOverviewSettingsRow(props, hostIds);
  const offers = useOverviewTeamOffers(props, hostIds, row, action);
  const { model, current, teamOwner, environmentId, claimEnvironmentId } = row;
  const { editableTeams, mayOfferGive, mayClaim, teamListError, retryTeams } =
    offers;

  if (shouldCloseOverviewAction(action, props, row, offers)) setAction(null);

  const closeAction = (): void => setAction(null);
  const detailsTrigger =
    current === null ? null : (
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={() =>
          setDetails({ ...current, client: dialogClient(current.client) })
        }
      >
        Details
      </Button>
    );
  const renderRow = (): ReactNode => {
    if (model.kind === "loading" || current === null) {
      return (
        <SettingsRow
          row={HOST_OVERVIEW.definitions.settingsRow}
          control={
            <Skeleton
              className="h-7 w-[18ch]"
              role="status"
              aria-label="Reading"
            />
          }
        />
      );
    }
    if (model.kind === "team" || teamOwner !== null) {
      return (
        <TeamOwnedHostSettingsRow
          owner={teamOwner}
          fallback={model.kind === "team" ? model : null}
          details={detailsTrigger}
          claim={
            claimEnvironmentId !== null && mayClaim ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() =>
                  setAction({
                    kind: "claim",
                    environmentId: claimEnvironmentId,
                  })
                }
              >
                Claim this computer
              </Button>
            ) : null
          }
        />
      );
    }
    if (model.kind === "progress") {
      return (
        <SettingsRow
          row={HOST_OVERVIEW.definitions.settingsRow}
          status={
            <div className="flex flex-wrap items-center gap-1">
              <MoveProgressLine
                {...current}
                progress={model.progress}
                details={detailsTrigger}
              />
              {model.progress.kind === "move_stopped" ? detailsTrigger : null}
            </div>
          }
          control={
            <FixedSettingsSource
              value={model.progress.kind === "moving" ? "Personal" : hostName}
            />
          }
        />
      );
    }
    return (
      <div className="shrink-0" data-testid="host-settings-source">
        <SettingsRow
          row={HOST_OVERVIEW.definitions.settingsRow}
          status={
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span>{model.description}</span>
              {detailsTrigger}
            </div>
          }
          control={
            <>
              {mayOfferGive && teamListError ? (
                <TeamReadFailed
                  message="Couldn't load teams."
                  onRetry={retryTeams}
                />
              ) : null}
              <EnvironmentSourceSelect
                value={model.value}
                options={model.options}
                teams={mayOfferGive ? editableTeams : []}
                onChooseTeam={(team) =>
                  setAction({
                    kind: "give",
                    client: dialogClient(current.client),
                    currentEnvironmentId: environmentId,
                    team,
                  })
                }
                onChoose={(option) => {
                  if (option.action === "move") {
                    openMoveSheet({ hostId, hostName });
                  } else if (option.action === "stop_sharing") {
                    setAction({
                      kind: "stop",
                      client: dialogClient(current.client),
                    });
                  }
                }}
              />
            </>
          }
        />
      </div>
    );
  };

  return (
    <>
      {hidden === true ? null : renderRow()}
      {hidden === true ? null : <TransferReceipt value={receipt.line} />}
      {details === null ? null : (
        <OverviewCardDetailsDialog
          {...details}
          status={status ?? details.status}
          confirmBlocked={client === null}
          onClose={() => setDetails(null)}
        />
      )}
      {action?.kind === "stop" ? (
        <StopSharingSession
          client={action.client}
          hostId={hostId}
          hostName={hostName}
          open
          confirmBlocked={client === null}
          onOpenChange={(open) => {
            if (!open) closeAction();
          }}
        />
      ) : null}
      {action?.kind === "give" ? (
        <TeamGiveDialog
          key={action.team.environmentId}
          client={action.client}
          hostId={hostId}
          hostName={hostName}
          currentEnvironmentId={action.currentEnvironmentId}
          team={action.team}
          confirmBlocked={client === null}
          onClose={closeAction}
          onStarted={(team) => {
            receipt.giveStarted({
              teamId: team.ownerId,
              line: givenLine(hostName, team),
            });
          }}
          onGiven={(team) => {
            receipt.show(givenLine(hostName, team));
            closeAction();
          }}
        />
      ) : null}
      {action?.kind === "claim" ? (
        <ClaimLocalTeamComputer
          environmentId={action.environmentId}
          hostId={hostId}
          hostName={hostName}
          confirmBlocked={client === null}
          onClose={closeAction}
          onClaimed={receipt.show}
        />
      ) : null}
    </>
  );
}

interface OverviewSettingsRow {
  readonly model: HostSettingsRowModel;
  readonly current: OverviewCardLineProps | null;
  readonly teamOwner: Extract<
    HostOwnerPrincipal,
    { readonly kind: "team" }
  > | null;
  readonly teamRow: boolean;
  readonly environmentId: string | null;
  readonly claimEnvironmentId: string | null;
  readonly answered: boolean;
}

function useOverviewSettingsRow(
  props: HostOverviewSettingsCardProps,
  hostIds: readonly string[],
): OverviewSettingsRow {
  const { binding, client, hidden, hostId, hostName, owner, status } = props;
  const statusVersion =
    useHostNegotiatedMethodVersions(hostIds, "environment.status").get(
      hostId,
    ) ?? null;
  const model = hostSettingsRowModel(status, binding, hostName);
  useMatchEnvironmentRail(overviewRailPick(props, model, statusVersion));

  const current =
    hidden === true || client === null || status === null
      ? null
      : { client, hostId, hostName, status };
  const teamOwner = owner?.kind === "team" ? owner : null;
  const environmentId = binding?.environment.environmentId ?? null;
  return {
    model,
    current,
    teamOwner,
    teamRow: model.kind === "team" || teamOwner !== null,
    environmentId,
    claimEnvironmentId:
      props.isLocalMachine && teamOwner !== null ? environmentId : null,
    answered: current !== null && model.kind !== "loading",
  };
}

function overviewRailPick(
  props: HostOverviewSettingsCardProps,
  model: HostSettingsRowModel,
  version: NegotiatedMethodVersion,
): EnvironmentPick | null {
  const { hidden, hostId, hostName, status } = props;
  if (hidden === true || model.kind === "loading" || status === null)
    return null;
  return settingsRailPick({ model, hostId, hostName, status, version });
}

interface OverviewTeamOffers {
  readonly editableTeams: readonly EnvironmentDescriptorV11[];
  readonly mayOfferGive: boolean;
  readonly mayClaim: boolean;
  readonly giveWithdrawn: boolean;
  readonly teamWithdrawn: boolean;
  readonly teamListError: boolean;
  readonly retryTeams: () => void;
}

function useOverviewTeamOffers(
  props: HostOverviewSettingsCardProps,
  hostIds: readonly string[],
  row: OverviewSettingsRow,
  action: OpenSettingsAction | null,
): OverviewTeamOffers {
  const versions = useHostNegotiatedMethodVersions(
    hostIds,
    "environment.move.plan",
  );
  const giveSupport = overviewGiveSupport(versions.get(props.hostId) ?? null);
  const mayOfferGive = props.owner?.kind === "user" && giveSupport === true;
  const rowNeedsTeams = row.teamRow
    ? row.claimEnvironmentId !== null
    : row.model.kind === "select" && mayOfferGive;
  const actionEnvironmentId = teamActionEnvironmentId(action);
  const environments = useEnvironmentListQuery(
    actionEnvironmentId !== null || (row.answered && rowNeedsTeams),
  );
  const editableTeams = (environments.data?.environments ?? []).filter(
    isEditableTeam,
  );
  const teamListAnswered =
    environments.data !== undefined && !environments.isError;
  const hasEditableTeam = (id: string | null): boolean =>
    editableTeams.some((team) => team.environmentId === id);
  return {
    editableTeams,
    mayOfferGive,
    mayClaim: !environments.isError && hasEditableTeam(row.claimEnvironmentId),
    giveWithdrawn: giveSupport === false,
    teamWithdrawn:
      actionEnvironmentId !== null &&
      teamListAnswered &&
      !hasEditableTeam(actionEnvironmentId),
    teamListError: environments.isError,
    retryTeams: () => void environments.refetch(),
  };
}

function overviewGiveSupport(version: NegotiatedMethodVersion): boolean | null {
  if (version === null) return null;
  return version !== false && version.major === 2;
}

function isEditableTeam(team: EnvironmentDescriptorV11): boolean {
  return (
    team.ownerKind === "organization" &&
    mayChangeConfiguration(configurationRoleOf(team))
  );
}

function teamActionEnvironmentId(
  action: OpenSettingsAction | null,
): string | null {
  if (action?.kind === "give") return action.team.environmentId;
  if (action?.kind === "claim") return action.environmentId;
  return null;
}

function shouldCloseOverviewAction(
  action: OpenSettingsAction | null,
  props: HostOverviewSettingsCardProps,
  row: OverviewSettingsRow,
  offers: OverviewTeamOffers,
): boolean {
  if (action === null) return false;
  if (props.statusUnsupported === true || offers.teamWithdrawn) return true;
  if (action.kind === "give" && offers.giveWithdrawn) return true;
  if (!row.answered) return false;

  // A failed read can hide the row without withdrawing an open action.
  switch (action.kind) {
    case "stop":
      return row.teamRow || !offersStop(row.model);
    case "give":
      return row.teamRow || row.model.kind === "progress";
    case "claim":
      return (
        props.owner?.kind === "user" ||
        (row.claimEnvironmentId !== null &&
          row.claimEnvironmentId !== action.environmentId)
      );
  }
}

function offersStop(model: HostSettingsRowModel): boolean {
  return (
    model.kind === "select" &&
    model.options.some(
      (option) =>
        option.action === "stop_sharing" && option.value !== model.value,
    )
  );
}

/** Keep the cache keyed to the opening host while its directory route is away. */
function dialogClient(
  client: HostClient<HostRpcRegistry>,
): HostClient<HostRpcRegistry> {
  const entry = client.getActiveHost();
  return entry === null ? client : client.createRequester(entry);
}

function TeamOwnedHostSettingsRow(props: {
  readonly owner: Extract<HostOwnerPrincipal, { readonly kind: "team" }> | null;
  readonly fallback: Extract<
    HostSettingsRowModel,
    { readonly kind: "team" }
  > | null;
  readonly details: ReactNode;
  readonly claim: ReactNode;
}): ReactNode {
  return (
    <SettingsRow
      row={HOST_OVERVIEW.definitions.settingsRow}
      status={
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span>
            {props.owner === null
              ? props.fallback?.description
              : `This computer belongs to ${props.owner.name}.`}
          </span>
          {props.details}
        </div>
      }
      control={
        <div className="flex flex-wrap items-center gap-2">
          <FixedSettingsSource
            value={props.owner?.name ?? props.fallback?.label ?? "Team"}
          />
          {props.claim}
        </div>
      }
    />
  );
}

function ClaimLocalTeamComputer(props: {
  readonly environmentId: string;
  readonly hostId: string;
  readonly hostName: string;
  readonly onClaimed: (receipt: string) => void;
  readonly onClose: () => void;
  readonly confirmBlocked: boolean;
}): ReactNode {
  const mutation = useTeamComputerClaim(props.environmentId, () => {
    props.onClaimed(
      "This computer is now yours. The team can no longer run work on it.",
    );
    props.onClose();
  });
  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next && !mutation.isPending) props.onClose();
      }}
    >
      <DialogContent className="w-full sm:max-w-prose">
        <DialogHeader>
          <DialogTitle>Claim {props.hostName}?</DialogTitle>
          <DialogDescription>
            This computer will become yours. The team will lose access to it.
          </DialogDescription>
        </DialogHeader>
        <ClaimRunningWork
          hostId={props.hostId}
          environmentId={props.environmentId}
        />
        {mutation.isError ? (
          <p role="alert" className="text-ui-sm text-destructive">
            {mutation.error.message}
          </p>
        ) : null}
        <div className="flex flex-wrap justify-end gap-2">
          <Button
            type="button"
            variant="outline"
            disabled={mutation.isPending}
            onClick={props.onClose}
          >
            Cancel
          </Button>
          <Button
            type="button"
            disabled={mutation.isPending || props.confirmBlocked}
            onClick={() => mutation.mutate(props.hostId)}
          >
            {mutation.isPending ? (
              <AgentSpinningDots
                className={undefined}
                testId="team-computer-claim-progress"
                variant={undefined}
              />
            ) : null}
            Claim this computer
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** Keep the settings value in the same control while it cannot be changed. */
function FixedSettingsSource(props: { readonly value: string }): ReactNode {
  return (
    <Select value={props.value} disabled>
      <TooltipWrapper
        label={props.value}
        side="top"
        sideOffset={undefined}
        align="end"
      >
        <span className="max-w-full">
          <SelectTrigger
            size="sm"
            aria-label="Environment"
            className="max-w-[40vw] sm:max-w-64"
          >
            <SelectValue />
          </SelectTrigger>
        </span>
      </TooltipWrapper>
      <SelectContent align="end">
        <SelectItem value={props.value}>
          <EnvironmentOptionLabel label={props.value} detail={null} />
        </SelectItem>
      </SelectContent>
    </Select>
  );
}

interface EnvironmentSourceSelectProps {
  readonly value: HostSettingsRowOption["value"];
  readonly options: readonly HostSettingsRowOption[];
  readonly onChoose: (option: HostSettingsRowOption) => void;
}

function givenLine(hostName: string, team: EnvironmentDescriptorV11): string {
  return `${hostName} now belongs to ${team.label}. Any Admin or Editor of the team can claim it as their own.`;
}

function EnvironmentSourceSelect(
  props: EnvironmentSourceSelectProps & {
    readonly teams: readonly EnvironmentDescriptorV11[];
    readonly onChooseTeam: (team: EnvironmentDescriptorV11) => void;
  },
): ReactNode {
  const current = props.options.find((option) => option.value === props.value);
  return (
    <Select
      value={props.value}
      onValueChange={(value) => {
        const team = props.teams.find(
          (item) => `team:${item.environmentId}` === value,
        );
        if (team !== undefined) {
          props.onChooseTeam(team);
          return;
        }
        const option = props.options.find((item) => item.value === value);
        if (option === undefined || value === props.value) return;
        props.onChoose(option);
      }}
    >
      <TooltipWrapper
        label={current === undefined ? null : current.label}
        side="top"
        sideOffset={undefined}
        align="end"
      >
        <span className="max-w-full">
          <SelectTrigger
            size="sm"
            aria-label="Environment"
            className="max-w-[40vw] sm:max-w-64"
          >
            <SelectValue />
          </SelectTrigger>
        </span>
      </TooltipWrapper>
      <SelectContent align="end">
        {props.teams.map((team) => (
          <SelectItem
            key={team.environmentId}
            value={`team:${team.environmentId}`}
          >
            <EnvironmentOptionLabel
              label={team.label}
              detail="Use this computer for the team"
            />
          </SelectItem>
        ))}
        {props.options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            <EnvironmentOptionLabel
              label={option.label}
              detail={option.detail}
            />
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function EnvironmentOptionLabel(props: {
  readonly label: string;
  readonly detail: string | null;
}): ReactNode {
  return (
    <span className="flex min-w-0 flex-col items-start gap-0.5">
      <span className="truncate">{props.label}</span>
      {props.detail === null ? null : (
        <span className="text-ui-xs text-muted-foreground in-data-[slot=select-trigger]:hidden">
          {props.detail}
        </span>
      )}
    </span>
  );
}

/**
 * The rail follows a resolved source. A loading row and a failed read pass
 * null and leave the dropdown where the person put it.
 */
function railFollowKey(pick: EnvironmentPick): string {
  if (pick.kind === "local") {
    return `${environmentPickValue(pick)}:${pick.hostName}`;
  }
  return environmentPickValue(pick);
}

/**
 * Writes the host's source into the rail once per source. The source is
 * remembered even when the rail already shows it, so a pick made afterwards
 * is never replaced by it. A stale Local pick arrives as null and is never
 * written.
 */
function useMatchEnvironmentRail(pick: EnvironmentPick | null): void {
  const setPick = useSettingsEnvironmentPickStore((state) => state.setPick);
  const current = useSettingsEnvironmentPickStore(
    (state) => state.pick ?? state.defaultPick,
  );
  const nextKey = pick === null ? null : railFollowKey(pick);
  const currentKey = railFollowKey(current);
  const held = useRef<string | null>(null);
  useEffect(() => {
    if (pick === null || nextKey === null) return;
    if (held.current === nextKey) return;
    held.current = nextKey;
    if (nextKey !== currentKey) setPick(pick);
  }, [pick, nextKey, currentKey, setPick]);
}

/**
 * A Local pick the Environment dropdown would keep. One it would drop
 * (`isStaleLocalPick`: no Local row, or a row that needs an update) is not
 * written. The stopped-move row still shows the computer's name; the rail
 * stays where it is, because Personal is not what that row shows.
 */
function selectableLocalPick(
  hostId: string,
  hostName: string,
  status: EnvironmentStatusResponseV11,
  version: NegotiatedMethodVersion,
): EnvironmentPick | null {
  const pick: EnvironmentPick = { kind: "local", hostId, hostName };
  const row = localPickerRow({ hostId, name: hostName }, status, version);
  const stale = isStaleLocalPick(
    pick,
    {
      localRows: row === null ? [] : [row],
      defaultPick: PERSONAL_PICK,
    },
    new Map([[hostId, status]]),
  );
  return stale ? null : pick;
}

function settingsRailPick(input: {
  readonly model: Exclude<HostSettingsRowModel, { kind: "loading" }>;
  readonly hostId: string;
  readonly hostName: string;
  readonly status: EnvironmentStatusResponseV11;
  readonly version: NegotiatedMethodVersion;
}): EnvironmentPick | null {
  const { model, hostId, hostName, status, version } = input;
  if (model.kind === "team") {
    return { kind: "team", environmentId: model.environmentId };
  }
  if (model.kind === "progress") {
    return model.progress.kind === "moving"
      ? PERSONAL_PICK
      : selectableLocalPick(hostId, hostName, status, version);
  }
  return model.value === "local"
    ? selectableLocalPick(hostId, hostName, status, version)
    : PERSONAL_PICK;
}

/** A failed read shows nothing. Pending reads reserve the control. */
export function HostOverviewSettingsCardSlot(props: {
  readonly client: HostClient<HostRpcRegistry> | null;
  readonly hostId: string | null;
  readonly hostName: string;
  readonly usable: boolean;
  readonly owner: HostOwnerPrincipal | null;
  readonly isLocalMachine: boolean;
  readonly receipt: OwnershipReceipt;
  /** The card shows again after a time it could not: the host is back. */
  readonly onReturn: () => void;
}): ReactNode {
  const userId = useAuthStore((state) => state.contextMetadata?.userId ?? null);
  const status = useEnvironmentStatusRead(
    props.client,
    props.hostId,
    props.usable,
  );
  const bindingSupport = useHostMethodSupport(
    props.hostId,
    readsHostBindingsFromPool()
      ? "environment.binding.read"
      : "environment.host.read",
  );
  const binding = useEnvironmentHostReadQuery(
    props.client,
    props.hostId,
    props.usable && bindingSupport === true,
  );
  const hidden =
    !props.usable ||
    props.client === null ||
    props.hostId === null ||
    status.supported === false ||
    status.isError ||
    bindingReadHidesOverviewRow(bindingSupport, binding);
  const wasHidden = useRef(hidden);
  const { onReturn } = props;
  useEffect(() => {
    if (wasHidden.current && !hidden) onReturn();
    wasHidden.current = hidden;
  }, [hidden, onReturn]);
  if (props.hostId === null) return null;
  const statusUnsupported = props.usable && status.supported === false;
  return (
    <HostOverviewSettingsCard
      key={JSON.stringify([props.hostId, userId])}
      client={props.usable ? props.client : null}
      hostId={props.hostId}
      hostName={props.hostName}
      hidden={hidden}
      statusUnsupported={statusUnsupported}
      status={status.data}
      binding={binding.kind === "binding" ? (binding.query.data ?? null) : null}
      owner={props.owner}
      isLocalMachine={props.isLocalMachine}
      receipt={props.receipt}
    />
  );
}

function bindingReadHidesOverviewRow(
  supported: boolean | null,
  binding: EnvironmentHostRead,
): boolean {
  return (
    (supported === false && binding.kind !== "own_settings") ||
    binding.kind === "failed" ||
    (binding.kind === "binding" && binding.query.isError)
  );
}

function TransferReceipt(props: { readonly value: string | null }): ReactNode {
  return props.value === null ? null : (
    <p role="status" className="text-ui-sm">
      {props.value}
    </p>
  );
}
