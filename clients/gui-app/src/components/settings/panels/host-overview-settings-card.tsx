import {
  configurationRoleOf,
  mayChangeConfiguration,
} from "@/components/settings/environment/configuration-source";
import { localRowCohort } from "@/components/settings/environment/local-row-cohort";
import { TeamReadFailed } from "@/components/settings/environment/team-read-failed";
import { useTeamComputerClaim } from "@/hooks/auth/use-team-computers";
import { TeamGiveDialog } from "@/components/settings/panels/team-give-dialog";
import { useTeamConfigurationAccess } from "@/hooks/environment/use-may-change-team-configuration";
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
import type {
  EnvironmentStatusResponseV11,
  EnvironmentStatusResponseV13,
  EnvironmentStatusResponseV14,
} from "@traycer/protocol/host/environment-schemas";
import { OverviewCardDetailsLine } from "@/components/settings/details/overview-card-details-line";
import {
  isStaleLocalPick,
  localPickerRow,
} from "@/components/settings/environment/environment-picker-model";
import {
  MoveProgressLine,
  MoveRetryButton,
} from "@/components/settings/move/move-progress-line";
import { STOP_SHARING_TITLE } from "@/components/settings/move/stop-sharing-copy";
import {
  STOP_OWNERSHIP_CONFIRM_FLOOR,
  STOP_OWNERSHIP_PREVIEW_FLOOR,
} from "@/components/settings/move/stop-sharing-versions";
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
import { environmentReadLostAuthority } from "@/hooks/environment/environment-read-data";
import {
  useEnvironmentStatusRead,
  type EnvironmentRead,
} from "@/hooks/environment/use-environment-reads";
import {
  negotiatedVersionMeetsRequirement,
  type HostRpcError,
} from "@traycer-clients/shared/host-transport/host-messenger";
import {
  matchesStopPersonalBinding,
  type EnvironmentMoveStopPersonalBinding,
} from "@traycer/protocol/host/environment/move-contracts";
import {
  useHostNegotiatedMethodVersions,
  type NegotiatedMethodVersion,
} from "@/hooks/host/use-host-negotiated-method-version";
import {
  useHostMethodSupport,
  useHostMethodSchemaVersion,
} from "@/hooks/host/use-host-supports-method";
import type { HostRpcRegistry } from "@/lib/host";
import {
  environmentPickValue,
  PERSONAL_PICK,
  type EnvironmentPick,
} from "@/lib/settings-environment-pages";
import { useMoveSheetStore } from "@/stores/settings/move-sheet-store";
import {
  useEnvironmentPick,
  useSettingsEnvironmentPickStore,
} from "@/stores/settings/settings-environment-pick-store";

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

interface HostOverviewSettingsCardProps {
  readonly client: HostClient<HostRpcRegistry>;
  readonly hostId: string;
  readonly hostName: string;
  readonly status:
    | EnvironmentStatusResponseV13
    | EnvironmentStatusResponseV14
    | null;
  readonly binding: EnvironmentHostBinding | null;
  readonly owner: HostOwnerPrincipal | null;
  readonly isLocalMachine: boolean;
  readonly receipt: OwnershipReceipt;
}

/** The named host's settings place, above the Overview's tabs. */
export function HostOverviewSettingsCard(
  props: HostOverviewSettingsCardProps,
): ReactNode {
  const [openedBinding, setOpenedBinding] =
    useState<EnvironmentMoveStopPersonalBinding | null>(null);
  const previewVersion = useHostMethodSchemaVersion(
    props.hostId,
    STOP_OWNERSHIP_PREVIEW_FLOOR.method,
  );
  const confirmVersion = useHostMethodSchemaVersion(
    props.hostId,
    STOP_OWNERSHIP_CONFIRM_FLOOR.method,
  );
  const statusVersion = useHostMethodSchemaVersion(
    props.hostId,
    "environment.status",
  );
  const supportsOwnershipStop =
    negotiatedVersionMeetsRequirement(statusVersion ?? undefined, {
      method: "environment.status",
      version: { major: 1, minor: 4 },
    }) &&
    negotiatedVersionMeetsRequirement(
      previewVersion ?? undefined,
      STOP_OWNERSHIP_PREVIEW_FLOOR,
    ) &&
    negotiatedVersionMeetsRequirement(
      confirmVersion ?? undefined,
      STOP_OWNERSHIP_CONFIRM_FLOOR,
    );
  const status = props.status;
  const ownership =
    status !== null && "ownership" in status ? status.ownership : undefined;
  const refusalBinding =
    ownership?.unbound === false ? ownership.personalBinding : null;
  const supported = props.owner?.kind !== "team" && supportsOwnershipStop;
  const bindingToOpen = supported ? refusalBinding : null;
  // A healthy Personal row is a candidate recovery. The sheet re-reads its
  // own preview to verify the environment and sharing generation too.
  const canStayOpen =
    supported &&
    openedBinding !== null &&
    (matchesStopPersonalBinding(openedBinding, refusalBinding) ||
      (ownership === null &&
        status?.principal?.kind === "personal" &&
        status.bindingGeneration === openedBinding.bindingGeneration &&
        (status.planes.records === "moved" ||
          status.planes.records === "shared_unrecorded")));
  if (openedBinding !== null && !canStayOpen) setOpenedBinding(null);

  return (
    <>
      <HostOverviewSettingsCardContents
        {...props}
        refusalStopAction={
          bindingToOpen !== null ? (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => setOpenedBinding(bindingToOpen)}
            >
              {STOP_SHARING_TITLE}
            </Button>
          ) : null
        }
      />
      <StopSharingSession
        client={props.client}
        hostId={props.hostId}
        hostName={props.hostName}
        open={canStayOpen}
        expectedPersonalBinding={openedBinding}
        ownershipPreviewState={ownership === null ? "recovered" : "refused"}
        onOpenChange={(open) => {
          if (!open) setOpenedBinding(null);
        }}
      />
    </>
  );
}

function HostOverviewSettingsCardContents(
  props: HostOverviewSettingsCardProps & {
    readonly refusalStopAction: ReactNode;
  },
): ReactNode {
  const openMoveSheet = useMoveSheetStore((state) => state.openSheet);
  const [stopOpen, setStopOpen] = useState(false);
  const hostIds = useMemo(() => [props.hostId], [props.hostId]);
  const statusVersion =
    useHostNegotiatedMethodVersions(hostIds, "environment.status").get(
      props.hostId,
    ) ?? null;
  const model = hostSettingsRowModel(
    props.status,
    props.binding,
    props.hostName,
  );
  const railPick =
    model.kind === "loading" || props.status === null
      ? null
      : settingsRailPick({
          model,
          hostId: props.hostId,
          hostName: props.hostName,
          status: props.status,
          version: statusVersion,
        });
  useMatchEnvironmentRail(railPick);
  if (model.kind === "loading" || props.status === null) {
    return (
      <>
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
        <TransferReceipt value={props.receipt.line} />
      </>
    );
  }
  if (model.kind === "ownership_refused") {
    return (
      <>
        <SettingsRow
          row={HOST_OVERVIEW.definitions.settingsRow}
          status={
            <div className="flex flex-wrap items-center gap-1">
              <span>
                Couldn&apos;t read this computer&apos;s settings. Try again.
              </span>
              <MoveRetryButton
                client={props.client}
                hostId={props.hostId}
                variant="ghost"
              />
              {props.refusalStopAction}
            </div>
          }
          control={
            model.personal ? <FixedSettingsSource value="Personal" /> : null
          }
        />
        <TransferReceipt value={props.receipt.line} />
      </>
    );
  }
  const onChoose = (option: HostSettingsRowOption): void => {
    if (option.action === "move") {
      openMoveSheet({ hostId: props.hostId, hostName: props.hostName });
    } else if (option.action === "stop_sharing") {
      setStopOpen(true);
    }
  };
  return renderResolvedHostSettingsCard(
    { ...props, status: props.status },
    model,
    onChoose,
    { open: stopOpen, onOpenChange: setStopOpen },
  );
}

/** Keep the existing component tree: Details and Stop hold local state. */
function renderResolvedHostSettingsCard(
  props: HostOverviewSettingsCardProps & {
    readonly status:
      | EnvironmentStatusResponseV13
      | EnvironmentStatusResponseV14;
  },
  model: Exclude<
    HostSettingsRowModel,
    { readonly kind: "loading" | "ownership_refused" }
  >,
  onChoose: (option: HostSettingsRowOption) => void,
  stop: {
    readonly open: boolean;
    readonly onOpenChange: (open: boolean) => void;
  },
): ReactNode {
  const { open: stopOpen, onOpenChange: setStopOpen } = stop;
  const lineProps = {
    client: props.client,
    hostId: props.hostId,
    hostName: props.hostName,
    status: props.status,
  };
  if (model.kind === "personal_hold") {
    return (
      <>
        <div className="shrink-0" data-testid="host-settings-source">
          <SettingsRow
            row={HOST_OVERVIEW.definitions.settingsRow}
            status={
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span data-testid="host-settings-personal-hold">
                  {model.description}
                </span>
                <OverviewCardDetailsLine
                  {...lineProps}
                  currentStatus={model.description}
                />
              </div>
            }
            control={
              model.cause === "refused" ? (
                <FixedSettingsSource value={props.hostName} />
              ) : (
                <EnvironmentSourceControl
                  client={props.client}
                  hostId={props.hostId}
                  hostName={props.hostName}
                  owner={props.owner}
                  currentEnvironmentId={
                    props.binding?.environment.environmentId ?? null
                  }
                  receipt={props.receipt}
                  value="personal"
                  options={model.options}
                  onChoose={onChoose}
                />
              )
            }
          />
        </div>
        <StopSharingSession
          client={props.client}
          hostId={props.hostId}
          hostName={props.hostName}
          open={stopOpen}
          onOpenChange={setStopOpen}
        />
        <TransferReceipt value={props.receipt.line} />
      </>
    );
  }
  const teamOwner = props.owner?.kind === "team" ? props.owner : null;
  if (model.kind === "team" || teamOwner !== null) {
    return (
      <>
        <TeamOwnedHostSettingsRow
          {...lineProps}
          owner={teamOwner}
          binding={props.binding}
          fallback={model.kind === "team" ? model : null}
          isLocalMachine={props.isLocalMachine}
          onClaimed={props.receipt.show}
        />
        <TransferReceipt value={props.receipt.line} />
      </>
    );
  }
  if (model.kind === "progress") {
    return (
      <>
        <SettingsRow
          row={HOST_OVERVIEW.definitions.settingsRow}
          status={
            <div className="flex flex-wrap items-center gap-1">
              <MoveProgressLine {...lineProps} progress={model.progress} />
              {model.progress.kind === "move_stopped" ? (
                <OverviewCardDetailsLine {...lineProps} currentStatus={null} />
              ) : null}
            </div>
          }
          control={
            <FixedSettingsSource
              value={
                model.progress.kind === "moving" ? "Personal" : props.hostName
              }
            />
          }
        />
        <TransferReceipt value={props.receipt.line} />
      </>
    );
  }
  return (
    <>
      <div className="shrink-0" data-testid="host-settings-source">
        <SettingsRow
          row={HOST_OVERVIEW.definitions.settingsRow}
          status={
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span>{model.description}</span>
              <OverviewCardDetailsLine {...lineProps} currentStatus={null} />
            </div>
          }
          control={
            <EnvironmentSourceControl
              client={props.client}
              hostId={props.hostId}
              hostName={props.hostName}
              owner={props.owner}
              currentEnvironmentId={
                props.binding?.environment.environmentId ?? null
              }
              receipt={props.receipt}
              value={model.value}
              options={model.options}
              onChoose={onChoose}
            />
          }
        />
      </div>
      <StopSharingSession
        client={props.client}
        hostId={props.hostId}
        hostName={props.hostName}
        open={stopOpen}
        onOpenChange={setStopOpen}
      />
      <TransferReceipt value={props.receipt.line} />
    </>
  );
}

function TeamOwnedHostSettingsRow(props: {
  readonly client: HostClient<HostRpcRegistry>;
  readonly hostId: string;
  readonly hostName: string;
  readonly status: EnvironmentStatusResponseV11;
  readonly owner: Extract<HostOwnerPrincipal, { readonly kind: "team" }> | null;
  readonly binding: EnvironmentHostBinding | null;
  readonly fallback: Extract<
    HostSettingsRowModel,
    { readonly kind: "team" }
  > | null;
  readonly isLocalMachine: boolean;
  readonly onClaimed: (receipt: string) => void;
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
          <OverviewCardDetailsLine
            currentStatus={null}
            client={props.client}
            hostId={props.hostId}
            hostName={props.hostName}
            status={props.status}
          />
        </div>
      }
      control={
        <div className="flex flex-wrap items-center gap-2">
          <FixedSettingsSource
            value={props.owner?.name ?? props.fallback?.label ?? "Team"}
          />
          {props.isLocalMachine &&
          props.owner !== null &&
          props.binding !== null ? (
            <ClaimLocalTeamComputer
              environmentId={props.binding.environment.environmentId}
              hostId={props.hostId}
              hostName={props.hostName}
              onClaimed={props.onClaimed}
            />
          ) : null}
        </div>
      }
    />
  );
}

interface ClaimLocalTeamComputerProps {
  readonly environmentId: string;
  readonly hostId: string;
  readonly hostName: string;
  readonly onClaimed: (receipt: string) => void;
}

function ClaimLocalTeamComputer(props: ClaimLocalTeamComputerProps): ReactNode {
  const access = useTeamConfigurationAccess(props.environmentId);
  if (access === "denied") return null;
  return (
    <ClaimLocalTeamComputerDialog {...props} mayClaim={access === "allowed"} />
  );
}

function ClaimLocalTeamComputerDialog(
  props: ClaimLocalTeamComputerProps & { readonly mayClaim: boolean },
): ReactNode {
  const { mayClaim } = props;
  const [open, setOpen] = useState(false);
  const mutation = useTeamComputerClaim(props.environmentId, () => {
    props.onClaimed(
      "This computer is now yours. The team can no longer run work on it.",
    );
    setOpen(false);
  });
  if (!mayClaim && !open) return null;
  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={!mayClaim}
        onClick={() => {
          mutation.reset();
          setOpen(true);
        }}
      >
        Claim this computer
      </Button>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (!mutation.isPending) setOpen(next);
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
              onClick={() => setOpen(false)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              disabled={!mayClaim || mutation.isPending}
              onClick={() => {
                if (mayClaim) mutation.mutate(props.hostId);
              }}
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
    </>
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

function EnvironmentSourceControl(
  props: EnvironmentSourceSelectProps & {
    readonly client: HostClient<HostRpcRegistry>;
    readonly hostId: string;
    readonly hostName: string;
    readonly owner: HostOwnerPrincipal | null;
    readonly currentEnvironmentId: string | null;
    readonly receipt: OwnershipReceipt;
  },
): ReactNode {
  const planVersion = useHostMethodSchemaVersion(
    props.hostId,
    "environment.move.plan",
  );
  const mayTransfer = props.owner?.kind === "user" && planVersion?.major === 2;
  return mayTransfer ? (
    <TeamEnvironmentSourceControl {...props} />
  ) : (
    <EnvironmentSourceSelect
      {...props}
      teams={[]}
      onChooseTeam={() => undefined}
    />
  );
}

function TeamEnvironmentSourceControl(
  props: EnvironmentSourceSelectProps & {
    readonly client: HostClient<HostRpcRegistry>;
    readonly hostId: string;
    readonly hostName: string;
    readonly currentEnvironmentId: string | null;
    readonly receipt: OwnershipReceipt;
  },
): ReactNode {
  const environments = useEnvironmentListQuery(true);
  const teams = (environments.data?.environments ?? []).filter(
    (environment) =>
      environment.ownerKind === "organization" &&
      mayChangeConfiguration(configurationRoleOf(environment)),
  );
  const [selected, setSelected] = useState<EnvironmentDescriptorV11 | null>(
    null,
  );
  return (
    <>
      {environments.isError ? (
        <TeamReadFailed
          message="Couldn't load teams."
          onRetry={() => void environments.refetch()}
        />
      ) : null}
      <EnvironmentSourceSelect
        {...props}
        teams={teams}
        onChooseTeam={setSelected}
      />
      {selected === null ? null : (
        <TeamGiveDialog
          key={selected.environmentId}
          client={props.client}
          hostId={props.hostId}
          hostName={props.hostName}
          currentEnvironmentId={props.currentEnvironmentId}
          team={selected}
          onClose={() => setSelected(null)}
          onStarted={(team) => {
            props.receipt.giveStarted({
              teamId: team.ownerId,
              line: givenLine(props.hostName, team),
            });
          }}
          onGiven={(team) => {
            props.receipt.show(givenLine(props.hostName, team));
            setSelected(null);
          }}
        />
      )}
    </>
  );
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
  const current = useEnvironmentPick();
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
 * A Local pick on a computer that still has its Local row. One with no row,
 * or a row that needs an update (`isStaleLocalPick`), is not written: the
 * window reads it as the default. The stopped-move row still shows the
 * computer's name; the rail stays where it is, because Personal is not what
 * that row shows.
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
  // A Personal hold leaves the person's rail choice in place.
  if (model.kind === "personal_hold") return null;
  if (model.kind === "team") {
    return { kind: "team", environmentId: model.environmentId };
  }
  if (model.kind === "ownership_refused") {
    return model.personal ? PERSONAL_PICK : null;
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

/** Keep host recovery and an answered row through a failed reread. */
export function HostOverviewSettingsCardSlot(props: {
  readonly client: HostClient<HostRpcRegistry> | null;
  readonly hostId: string | null;
  readonly hostName: string;
  readonly usable: boolean;
  readonly owner: HostOwnerPrincipal | null;
  readonly isLocalMachine: boolean;
  readonly receipt: OwnershipReceipt;
  /** The host can answer again after a failure or a period away. */
  readonly onReturn: () => void;
}): ReactNode {
  const { client, hostId } = props;
  const userId = useAuthStore((state) => state.contextMetadata?.userId ?? null);
  const status = useEnvironmentStatusRead(client, hostId, props.usable);
  const bindingSupport = useHostMethodSupport(
    hostId,
    readsHostBindingsFromPool()
      ? "environment.binding.read"
      : "environment.host.read",
  );
  const binding = useEnvironmentHostReadQuery(
    client,
    hostId,
    props.usable && bindingSupport === true,
  );
  const scope = JSON.stringify([hostId, userId]);
  const bindingRead = overviewBindingRead(binding, status.data);
  const bindingRefused = useOverviewBindingRefusal(scope, bindingRead);
  const owner = bindingRefused ? null : props.owner;
  const usableScope = props.usable && client !== null && hostId !== null;
  const read = overviewSlotRead({
    status,
    binding,
    bindingSupport,
    bindingRead,
    bindingRefused,
    owner,
    hostName: props.hostName,
    usableScope,
  });
  const observed = useObservedOverviewSubject(
    scope,
    read.subject,
    read.answered,
  );
  const unavailable = read.hidden || read.failed;
  const wasUnavailable = useRef(unavailable);
  const { onReturn } = props;
  useEffect(() => {
    if (wasUnavailable.current && !unavailable) onReturn();
    wasUnavailable.current = unavailable;
  }, [unavailable, onReturn]);
  if (read.hidden || !usableScope) return null;
  if (read.failed && !observed) return null;
  return (
    <HostOverviewSettingsCard
      key={scope}
      client={client}
      hostId={hostId}
      hostName={props.hostName}
      status={status.data}
      binding={read.binding}
      owner={owner}
      isLocalMachine={props.isLocalMachine}
      receipt={props.receipt}
    />
  );
}

/** A failed reread may keep the subject this mounted host and viewer already saw. */
function useObservedOverviewSubject(
  scope: string,
  subject: string | null,
  answered: boolean,
): boolean {
  const [seen, setSeen] = useState<{ scope: string; subject: string | null }>({
    scope,
    subject: null,
  });
  const observed =
    subject !== null &&
    (answered || (seen.scope === scope && seen.subject === subject));
  const current = observed ? subject : null;
  if (seen.scope !== scope || seen.subject !== current)
    setSeen({ scope, subject: current });
  return observed;
}

/** A transport error can replace a refusal while the binding is still unanswered. */
function useOverviewBindingRefusal(
  scope: string,
  binding: OverviewBindingRead,
): boolean {
  const [refusedScope, setRefusedScope] = useState<string | null>(null);
  const refused =
    binding.authorityLost || (!binding.answered && refusedScope === scope);
  const current = refused ? scope : null;
  if (refusedScope !== current) setRefusedScope(current);
  return refused;
}

function overviewSlotRead(input: {
  readonly status: EnvironmentRead<EnvironmentStatusResponseV14> & {
    readonly error: HostRpcError | null;
  };
  readonly binding: EnvironmentHostRead;
  readonly bindingSupport: boolean | null;
  readonly bindingRead: OverviewBindingRead;
  readonly bindingRefused: boolean;
  readonly owner: HostOwnerPrincipal | null;
  readonly hostName: string;
  readonly usableScope: boolean;
}): {
  readonly binding: EnvironmentHostBinding | null;
  readonly failed: boolean;
  readonly hidden: boolean;
  readonly subject: string | null;
  readonly answered: boolean;
} {
  const { status, bindingRead, bindingRefused } = input;
  const binding = bindingRefused ? null : bindingRead.data;
  const statusCanShowRow = hasOverviewStatusWithoutBinding(
    status.data,
    input.owner,
  );
  const bindingFailed =
    bindingRead.failed ||
    (bindingRefused && input.binding.kind !== "own_settings");
  const missingBinding = lacksRequiredOverviewBinding(
    input.bindingSupport,
    input.binding,
    status,
  );
  const hidden =
    environmentReadLostAuthority(status.error) ||
    !input.usableScope ||
    status.supported === false ||
    (!statusCanShowRow && (missingBinding || bindingRefused));
  return {
    binding,
    failed: status.isError || bindingFailed,
    hidden,
    subject: hidden
      ? null
      : overviewRowSubject(status.data, binding, input.owner, input.hostName),
    answered: !status.isError && (statusCanShowRow || !bindingFailed),
  };
}

function hasOverviewStatusWithoutBinding(
  status: EnvironmentStatusResponseV14 | null,
  owner: HostOwnerPrincipal | null,
): boolean {
  return (
    status !== null &&
    (status.ownership !== null ||
      status.personalHold !== "none" ||
      (owner?.kind !== "team" && localRowCohort(status).kind === "local"))
  );
}

function overviewRowSubject(
  status: EnvironmentStatusResponseV14 | null,
  binding: EnvironmentHostBinding | null,
  owner: HostOwnerPrincipal | null,
  hostName: string,
): string | null {
  if (status === null) return null;
  const teamOwner = owner?.kind === "team" ? owner.id : null;
  const bindingId = binding?.environment.environmentId ?? null;
  if (status.ownership !== null) {
    const effectiveOwner = status.ownership.unbound ? teamOwner : null;
    return JSON.stringify([
      "ownership",
      status.ownership.unbound,
      status.ownership.personalBinding?.environmentId ?? null,
      effectiveOwner,
      effectiveOwner === null ? null : bindingId,
    ]);
  }
  const model = hostSettingsRowModel(status, binding, hostName);
  if (model.kind === "loading") return null;
  if (model.kind === "personal_hold") return `hold:${model.cause}`;
  if (teamOwner === null && localRowCohort(status).kind === "local")
    return "local";
  return JSON.stringify(["binding", bindingId, teamOwner]);
}

/** An earlier Local status is sufficient while its fresh read is unavailable. */
function lacksRequiredOverviewBinding(
  bindingSupport: boolean | null,
  binding: EnvironmentHostRead,
  status: {
    readonly isError: boolean;
    readonly data: EnvironmentStatusResponseV13 | null;
  },
): boolean {
  if (bindingSupport !== false || binding.kind === "own_settings") return false;
  if (!status.isError || status.data === null) return true;
  return localRowCohort(status.data).kind !== "local";
}

interface OverviewBindingRead {
  readonly data: EnvironmentHostBinding | null;
  readonly failed: boolean;
  readonly authorityLost: boolean;
  readonly answered: boolean;
}

function overviewBindingRead(
  read: EnvironmentHostRead,
  lastStatus: EnvironmentStatusResponseV14 | null,
): OverviewBindingRead {
  if (read.kind === "binding") {
    const authorityLost = environmentReadLostAuthority(
      read.query.error ?? null,
    );
    const data = authorityLost ? null : (read.query.data ?? null);
    return {
      data,
      failed: read.query.isError,
      authorityLost,
      answered: data !== null && !read.query.isError,
    };
  }
  if (read.kind === "failed") {
    // An answered Local status did not expose the pooled binding to this row.
    const wasLocal =
      lastStatus !== null && localRowCohort(lastStatus).kind === "local";
    return {
      data: read.bindingAuthorityLost || wasLocal ? null : read.lastBinding,
      failed: true,
      authorityLost: read.bindingAuthorityLost,
      answered: false,
    };
  }
  return { data: null, failed: false, authorityLost: false, answered: false };
}

function TransferReceipt(props: { readonly value: string | null }): ReactNode {
  return props.value === null ? null : (
    <p role="status" className="text-ui-sm">
      {props.value}
    </p>
  );
}
