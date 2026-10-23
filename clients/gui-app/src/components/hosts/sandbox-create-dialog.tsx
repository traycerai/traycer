import { useEffect, useId, useState, type ReactNode } from "react";
import { useIsMutating } from "@tanstack/react-query";
import type { AuthenticatedUser } from "@traycer/protocol/auth";
import {
  SANDBOX_REFUSAL_CODE_ENVIRONMENT_NOT_FOUND,
  SANDBOX_REFUSAL_CODE_ENVIRONMENT_UNAVAILABLE,
  SANDBOX_REFUSAL_CODE_INSUFFICIENT_CREDIT,
  type SandboxCatalogue,
  type SandboxCatalogueProvider,
  type SandboxCatalogueRegion,
  type SandboxOs,
  type SandboxShapeBounds,
} from "@traycer/protocol/host/sandbox-control";
import {
  defaultBelongsTo,
  SANDBOX_CREATE_ASK_ADMIN_LABEL,
  SANDBOX_CREATE_ENVIRONMENT_UNAVAILABLE_LINE,
  sandboxCreateTeams,
  sandboxNoProvidersLine,
  sandboxNotAMemberLine,
  sandboxTeamCreateLines,
  teamCannotCoverAnHour,
  teamHasNoProviders,
  teamSandboxBalanceMc,
  type SandboxCreateBelongsTo,
  type SandboxCreateTeam,
} from "@/components/hosts/sandbox-create-model";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import { useNavigate } from "@tanstack/react-router";
import { SandboxCreateStartTeamTask } from "@/components/hosts/sandbox-create-start-team-task";
import { usePersonHasTeamTask } from "@/hooks/epics/use-epic-owning-team";
import { openNewEpicIntent } from "@/lib/commands/actions/new-epic";
import { pinComposerHost } from "@/lib/composer/start-task-on-host";
import { navigateToTabIntent } from "@/lib/tab-navigation";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useAuthUser } from "@/hooks/auth/use-auth-user-query";
import { useEnvironmentProviders } from "@/hooks/sandboxes/use-environment-providers-query";
import { useSandboxCatalogue } from "@/hooks/sandboxes/use-sandbox-catalogue-query";
import {
  SandboxCreateError,
  useSandboxCreate,
  type SandboxCreateSubmit,
} from "@/hooks/sandboxes/use-sandbox-create-mutation";
import { useTeamEnvironment } from "@/hooks/sandboxes/use-team-environment-query";
import type { TeamEnvironmentFetchResult } from "@traycer-clients/shared/host-client/sandbox-secrets";
import {
  formatCredits,
  formatMemory,
  roundSandboxShape,
  roundUpToStep,
  sandboxShapeProblem,
  type SandboxShape,
} from "@/lib/sandboxes/sandbox-pricing";
import { sandboxMutationKeys } from "@/lib/query-keys";
import { useAuthStore } from "@/stores/auth/auth-store";
import {
  useSandboxCreateDialogStore,
  type SandboxCreatedLine,
  type SandboxCreateDraft,
} from "@/stores/settings/sandbox-create-dialog-store";

const MB_PER_GIB = 1024;
/** A team sandbox opens with at least this much memory. */
const TEAM_DEFAULT_MEMORY_MB = 2 * MB_PER_GIB;
const NAME_MAX_LENGTH = 191;

/**
 * Idle periods the form offers, in minutes. The server takes 2 minutes to one
 * week; these are the core flows' choices inside that range. The server has
 * no "never" yet (`null` means its 30-minute default), so neither does the
 * form.
 */
const IDLE_CHOICES: readonly {
  readonly minutes: number;
  readonly label: string;
}[] = [
  { minutes: 5, label: "5 minutes" },
  { minutes: 30, label: "30 minutes" },
  { minutes: 120, label: "2 hours" },
  { minutes: 1440, label: "24 hours" },
];
const DEFAULT_IDLE_MINUTES = 30;

const OS_LABEL: Record<SandboxOs, string> = {
  linux: "Linux",
  windows: "Windows",
};

/**
 * Creating a sandbox from Settings: whom it belongs to (Personal or one of
 * the person's teams), OS, a free-form size within the catalogue's bounds,
 * region, idle period and name, from `GET /api/sandboxes/catalogue`. Mounted
 * once beside the add-host dialog and opened through its store, with the
 * entry's preselection.
 *
 * A team pick always shows its four lines, warns
 * when the team has no provider, names the team on a refusal the server
 * leaves unnamed, and asks the person to go to a team admin when their
 * bundle under the team cannot cover an hour.
 */
export function SandboxCreateDialog(): ReactNode {
  const open = useSandboxCreateDialogStore((s) => s.open);
  const closeDialog = useSandboxCreateDialogStore((s) => s.closeDialog);
  // Keyed on the open: a new open is a new form, even one asked for while
  // the dialog was already up.
  const openId = useSandboxCreateDialogStore((s) => s.openId);
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) closeDialog();
      }}
    >
      <DialogContent
        className="w-[min(92vw,30rem)] sm:max-w-[min(92vw,30rem)]"
        data-testid="sandbox-create-dialog"
      >
        <DialogHeader>
          <DialogTitle>New sandbox</DialogTitle>
          <DialogDescription>
            A cloud machine your agents can run on. It is billed by the hour
            while awake and suspends when idle.
          </DialogDescription>
        </DialogHeader>
        {open ? (
          <SandboxCreateDialogBody key={openId} onDone={closeDialog} />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function SandboxCreateDialogBody(props: {
  readonly onDone: () => void;
}): ReactNode {
  const signedIn = useAuthStore((s) => s.status === "signed-in");
  const catalogue = useSandboxCatalogue(true);
  const userQuery = useAuthUser();
  const user = userQuery.data ?? null;
  const preselect = useSandboxCreateDialogStore((s) => s.preselect);
  const workingHostTeamId = useSandboxCreateDialogStore(
    (s) => s.workingHostTeamId,
  );
  // Signed out, the catalogue query is disabled and stays pending with no
  // fetch behind it: say why instead of spinning.
  if (!signedIn) {
    return withFailure(
      <p
        className="text-ui-sm text-muted-foreground"
        data-testid="sandbox-create-signed-out"
      >
        Sign in to create a sandbox.
      </p>,
    );
  }
  // The form takes its Belongs to once, from the person's teams: wait for
  // them, or a team preselection would open on Personal.
  if (catalogue.isPending || userQuery.isPending) {
    return withFailure(
      <div className="flex items-center gap-2 text-ui-sm text-muted-foreground">
        <AgentSpinningDots
          className={undefined}
          testId="sandbox-create-loading"
          variant={undefined}
        />
        Loading sizes and regions…
      </div>,
    );
  }
  if (catalogue.isError) {
    return withFailure(
      <SandboxCreateRetry
        message={catalogue.error.message}
        onRetry={() => void catalogue.refetch()}
      />,
    );
  }
  // Settled with no user is a failed first read. Without the person's teams
  // the form could only be Personal: say so when the opener named a team. A
  // failed refetch keeps the teams it had, and a Personal create needs none.
  const opensOnTeam = preselect?.kind === "team" || workingHostTeamId !== null;
  if (userQuery.data === undefined && opensOnTeam) {
    return withFailure(
      <SandboxCreateRetry
        message="Traycer couldn't load your teams."
        onRetry={() => void userQuery.refetch()}
      />,
    );
  }
  const offered = offeredOses(catalogue.data);
  if (offered.length === 0) {
    return withFailure(
      <p className="text-ui-sm text-muted-foreground">
        Sandboxes aren&apos;t offered right now.
      </p>,
    );
  }
  const teams = sandboxCreateTeams(user);
  return (
    <SandboxCreateForm
      catalogue={catalogue.data}
      initialOs={offered[0]}
      user={user}
      teams={teams}
      initialBelongsTo={defaultBelongsTo(preselect, workingHostTeamId, teams)}
      onDone={props.onDone}
    />
  );
}

interface SandboxFormState {
  readonly name: string;
  readonly os: SandboxOs;
  readonly cpus: string;
  readonly memoryGb: string;
  readonly region: string;
  readonly idleMinutes: number;
}

/**
 * The size a create opens at: the provider's smallest for a personal
 * sandbox. A team one opens at the smallest shape, under the same rounding
 * and validation the create uses, that gives at least 2 GB; a provider that
 * cannot reach 2 GB opens at its largest valid memory on the fewest vCPUs.
 */
function defaultShape(
  bounds: SandboxShapeBounds,
  belongsTo: SandboxCreateBelongsTo,
): SandboxShape {
  const smallest = {
    cpus: bounds.cpuMin,
    memoryMb: Math.max(
      bounds.memoryMinMb,
      bounds.cpuMin * bounds.memoryPerCpuMinMb,
    ),
  };
  if (belongsTo.kind === "personal") return smallest;
  let largestValid: SandboxShape | null = null;
  for (const cpus of cpuCandidates(bounds)) {
    const shape = roundSandboxShape(bounds, {
      cpus,
      memoryMb: Math.max(
        TEAM_DEFAULT_MEMORY_MB,
        bounds.memoryMinMb,
        cpus * bounds.memoryPerCpuMinMb,
      ),
    });
    if (sandboxShapeProblem(bounds, shape) !== null) continue;
    if (shape.memoryMb >= TEAM_DEFAULT_MEMORY_MB) return shape;
    if (largestValid === null || shape.memoryMb > largestValid.memoryMb) {
      largestValid = shape;
    }
  }
  return largestValid ?? smallest;
}

/**
 * Every vCPU count a create can ask for, ascending: the grid from the
 * minimum, and the maximum itself, which the rounding clamps to when it
 * sits between steps.
 */
function cpuCandidates(bounds: SandboxShapeBounds): readonly number[] {
  const candidates: number[] = [];
  for (let step = 0; ; step += 1) {
    const cpus = roundUpToStep(
      bounds.cpuMin + step * bounds.cpuStep,
      bounds.cpuStep,
      bounds.cpuMin,
    );
    if (cpus > bounds.cpuMax) break;
    candidates.push(cpus);
  }
  if (candidates.at(-1) !== bounds.cpuMax) candidates.push(bounds.cpuMax);
  return candidates;
}

/** A shape as the form's vCPU and memory fields hold it. */
function shapeFields(
  shape: SandboxShape,
): Pick<SandboxFormState, "cpus" | "memoryGb"> {
  return {
    cpus: String(shape.cpus),
    memoryGb: String(shape.memoryMb / MB_PER_GIB),
  };
}

function initialFormState(
  provider: SandboxCatalogueProvider,
  os: SandboxOs,
  belongsTo: SandboxCreateBelongsTo,
): SandboxFormState {
  return {
    name: "",
    os,
    ...shapeFields(defaultShape(provider.shape, belongsTo)),
    // The server's own default: its first priced region.
    region: provider.regions.at(0)?.id ?? "",
    idleMinutes: DEFAULT_IDLE_MINUTES,
  };
}

/**
 * The form's starting values: the draft a remount left behind when its OS is
 * still offered, else the catalogue's defaults.
 */
function draftFormState(
  draft: SandboxCreateDraft | null,
  catalogue: SandboxCatalogue,
  initialOs: SandboxOs,
  initialBelongsTo: SandboxCreateBelongsTo,
): SandboxFormState {
  if (draft !== null && offeredOses(catalogue).includes(draft.os)) {
    return {
      name: draft.name,
      os: draft.os,
      cpus: draft.cpus,
      memoryGb: draft.memoryGb,
      region: draft.region,
      idleMinutes: draft.idleMinutes,
    };
  }
  return initialFormState(
    providerFor(catalogue, initialOs),
    initialOs,
    initialBelongsTo,
  );
}

/**
 * The form's values, kept in the dialog store as they change so a remount
 * while the dialog is open starts from them rather than the defaults.
 * The draft is read once, at mount.
 */
function useSandboxCreateDraft(
  catalogue: SandboxCatalogue,
  initialOs: SandboxOs,
  initialBelongsTo: SandboxCreateBelongsTo,
): {
  readonly belongsTo: SandboxCreateBelongsTo;
  readonly setBelongsTo: (belongsTo: SandboxCreateBelongsTo) => void;
  readonly form: SandboxFormState;
  readonly setForm: (form: SandboxFormState) => void;
} {
  const [draft] = useState(() => useSandboxCreateDialogStore.getState().draft);
  const setDraft = useSandboxCreateDialogStore((s) => s.setDraft);
  const [belongsTo, setBelongsTo] = useState<SandboxCreateBelongsTo>(
    draft === null ? initialBelongsTo : draft.belongsTo,
  );
  const [form, setForm] = useState<SandboxFormState>(() =>
    draftFormState(draft, catalogue, initialOs, initialBelongsTo),
  );
  useEffect(() => {
    setDraft({ ...form, belongsTo });
  }, [belongsTo, form, setDraft]);
  return { belongsTo, setBelongsTo, form, setForm };
}

/** The last create's failure, said beside the values that were sent. */
function SandboxCreateFailure(props: { readonly shown: boolean }): ReactNode {
  const failure = useSandboxCreateDialogStore((s) => s.failure);
  if (!props.shown || failure === null) return null;
  return (
    <p
      className="text-ui-sm text-destructive"
      role="alert"
      data-testid="sandbox-create-failure"
    >
      {failure.message}
    </p>
  );
}

/**
 * A body state other than the form, with the last create's failure under it:
 * a create can settle while the body waits on a read.
 */
function withFailure(node: ReactNode): ReactNode {
  return (
    <>
      {node}
      <SandboxCreateFailure shown />
    </>
  );
}

/**
 * A create in flight for this account holds the submit, and so does one that
 * already succeeded in this open: the form is closing or offering the team
 * task, and its values were sent.
 */
function submitHeld(
  creating: boolean,
  created: SandboxCreatedLine | null,
): boolean {
  return creating || created !== null;
}

/** What the OS select needs: the form it switches. */
interface SandboxOsSelectProps {
  readonly id: string;
  readonly catalogue: SandboxCatalogue;
  readonly belongsTo: SandboxCreateBelongsTo;
  readonly form: SandboxFormState;
  readonly setForm: (form: SandboxFormState) => void;
}

/** The OS pick; a switch starts the new provider's defaults, keeping the name. */
function SandboxOsSelect(props: SandboxOsSelectProps): ReactNode {
  return (
    <SandboxCreateSelect
      id={props.id}
      label="Operating system"
      value={props.form.os}
      testId={null}
      options={offeredOses(props.catalogue).map((os) => ({
        value: os,
        label: OS_LABEL[os],
      }))}
      onChange={(value) => {
        const os = offeredOses(props.catalogue).find((o) => o === value);
        if (os === undefined) return;
        props.setForm({
          ...initialFormState(
            providerFor(props.catalogue, os),
            os,
            props.belongsTo,
          ),
          name: props.form.name,
          idleMinutes: props.form.idleMinutes,
        });
      }}
    />
  );
}

/**
 * What the form shows instead of itself: the team-task offer once a
 * create landed, or, for a provider the account's plan cannot create,
 * the OS pick and why, with no size, price or Create. Its shape bounds are
 * not a shape (max below min), so nothing is computed from them.
 */
function formReplacement(
  offer: FirstTeamTaskOffer | null,
  provider: SandboxCatalogueProvider,
  osSelect: SandboxOsSelectProps & {
    readonly onDone: () => void;
    /** A create for this account is in flight, from this open or another. */
    readonly creating: boolean;
  },
): ReactNode | null {
  if (offer !== null) {
    return (
      <StartTeamTaskSuccess
        teamSlug={offer.teamSlug}
        hostId={offer.hostId}
        onDone={osSelect.onDone}
      />
    );
  }
  if (provider.creatable) return null;
  return (
    <div className="flex flex-col gap-4">
      <SandboxOsSelect
        id={osSelect.id}
        catalogue={osSelect.catalogue}
        belongsTo={osSelect.belongsTo}
        form={osSelect.form}
        setForm={osSelect.setForm}
      />
      <p
        className="text-ui-sm text-muted-foreground"
        data-testid="sandbox-create-not-creatable"
      >
        {/* Whatever the catalogue's reason, nothing about it is the
            person's to change: the line says only that. */}
        Sandboxes can&apos;t be created on this account right now.
      </p>
      {/* A create sent from another OS still runs: say so here too. */}
      {osSelect.creating ? (
        <p
          className="text-ui-sm text-muted-foreground"
          data-testid="sandbox-create-in-flight"
        >
          A sandbox is being created…
        </p>
      ) : null}
      <SandboxCreateFailure shown />
    </div>
  );
}

/** A read the form needs failed: say so, with a retry. */
function SandboxCreateRetry(props: {
  readonly message: string;
  readonly onRetry: () => void;
}): ReactNode {
  return (
    <div className="flex flex-col items-start gap-2">
      <p className="text-ui-sm text-muted-foreground">{props.message}</p>
      <Button type="button" variant="outline" size="sm" onClick={props.onRetry}>
        Try again
      </Button>
    </div>
  );
}

function SandboxCreateForm(props: {
  readonly catalogue: SandboxCatalogue;
  readonly initialOs: SandboxOs;
  readonly user: AuthenticatedUser | null;
  readonly teams: readonly SandboxCreateTeam[];
  readonly initialBelongsTo: SandboxCreateBelongsTo;
  readonly onDone: () => void;
}): ReactNode {
  const ids = useId();
  const { belongsTo, setBelongsTo, form, setForm } = useSandboxCreateDraft(
    props.catalogue,
    props.initialOs,
    props.initialBelongsTo,
  );
  const setFailure = useSandboxCreateDialogStore((s) => s.setFailure);
  const created = useSandboxCreateDialogStore((s) => s.created);
  const team = pickedTeam(belongsTo, props.teams);
  const firstTeamTaskOffer = useFirstTeamTaskOffer(
    created,
    props.teams,
    props.onDone,
  );
  const create = useSandboxCreate();
  // A create outlives this form: closing the dialog unmounts it, and a
  // reopened form's own mutation is idle. Any create in flight for this
  // account, from any mount, holds the submit, so a second one is never sent
  // meanwhile; another account's create does not.
  const userId = useAuthStore((s) => s.contextMetadata?.userId ?? null);
  const creating =
    useIsMutating({ mutationKey: sandboxMutationKeys.create(userId) }) > 0;
  const provider = providerFor(props.catalogue, form.os);
  const requested = {
    cpus: Number(form.cpus),
    memoryMb: Math.round(Number(form.memoryGb) * MB_PER_GIB),
  };
  const problem = sandboxShapeProblem(provider.shape, requested);
  const rounded = roundSandboxShape(provider.shape, requested);
  const region =
    provider.regions.find((candidate) => candidate.id === form.region) ??
    provider.regions.at(0) ??
    null;
  const name = form.name.trim();
  const target = useTeamTarget(team, props.user, create, {
    region,
    shape: rounded,
  });
  const canSubmit =
    problem === null &&
    region !== null &&
    name.length > 0 &&
    !submitHeld(creating, created) &&
    target.ready;

  const replacement = formReplacement(firstTeamTaskOffer, provider, {
    id: `${ids}-os`,
    catalogue: props.catalogue,
    belongsTo,
    form,
    setForm,
    onDone: props.onDone,
    creating,
  });
  if (replacement !== null) return replacement;

  return (
    // `noValidate`: the number inputs carry the catalogue's min / max / step
    // for their spinners, and native validation would refuse an off-step
    // value (2.1 GB, 1.5 vCPU) before `onSubmit` ran - the very value the
    // price line says will be rounded. Range is `sandboxShapeProblem`'s to
    // refuse; the step is `roundSandboxShape`'s to apply.
    <form
      noValidate
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (!canSubmit) return;
        setFailure(null);
        create.mutate({
          request: {
            os: form.os,
            cpus: rounded.cpus,
            memoryMb: rounded.memoryMb,
            diskMb: null,
            region: region.id,
            displayName: name,
            idleMinutes: form.idleMinutes,
            burst: false,
            createdByHostId: null,
            createdByAgentId: null,
            // Personal stays `null`, the request as it always was.
            environmentId: target.environmentId,
            destroyAfterRestingMinutes: null,
            createdByTaskId: null,
            clientRequestId: null,
          },
          teamName: target.teamName,
          teamId: target.teamId,
        });
      }}
    >
      <SandboxBelongsToField
        id={`${ids}-belongs-to`}
        teams={props.teams}
        team={team}
        target={target}
        onChange={(next) => {
          setBelongsTo(next);
          // An untouched size follows the new default; an edited one stays.
          const previous = defaultShape(provider.shape, belongsTo);
          if (
            Number(form.cpus) !== previous.cpus ||
            Number(form.memoryGb) * MB_PER_GIB !== previous.memoryMb
          ) {
            return;
          }
          setForm({
            ...form,
            ...shapeFields(defaultShape(provider.shape, next)),
          });
        }}
      />
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`${ids}-name`}>Name</Label>
        <Input
          id={`${ids}-name`}
          value={form.name}
          maxLength={NAME_MAX_LENGTH}
          placeholder="build-box"
          data-testid="sandbox-create-name"
          onChange={(event) => setForm({ ...form, name: event.target.value })}
        />
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <SandboxOsSelect
          id={`${ids}-os`}
          catalogue={props.catalogue}
          belongsTo={belongsTo}
          form={form}
          setForm={setForm}
        />
        <SandboxCreateSelect
          id={`${ids}-region`}
          label="Region"
          value={region?.id ?? ""}
          options={provider.regions.map((candidate) => ({
            value: candidate.id,
            label: candidate.label,
          }))}
          testId={null}
          onChange={(value) => setForm({ ...form, region: value })}
        />
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${ids}-cpus`}>vCPU</Label>
          <Input
            id={`${ids}-cpus`}
            type="number"
            inputMode="decimal"
            min={provider.shape.cpuMin}
            max={provider.shape.cpuMax}
            step={provider.shape.cpuStep}
            value={form.cpus}
            data-testid="sandbox-create-cpus"
            onChange={(event) => setForm({ ...form, cpus: event.target.value })}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${ids}-memory`}>Memory (GB)</Label>
          <Input
            id={`${ids}-memory`}
            type="number"
            inputMode="decimal"
            min={provider.shape.memoryMinMb / MB_PER_GIB}
            max={provider.shape.memoryMaxMb / MB_PER_GIB}
            step={provider.shape.memoryStepMb / MB_PER_GIB}
            value={form.memoryGb}
            data-testid="sandbox-create-memory"
            onChange={(event) =>
              setForm({ ...form, memoryGb: event.target.value })
            }
          />
        </div>
        <SandboxCreateSelect
          id={`${ids}-idle`}
          label="Suspend when idle for"
          value={String(form.idleMinutes)}
          options={IDLE_CHOICES.map((choice) => ({
            value: String(choice.minutes),
            label: choice.label,
          }))}
          testId={null}
          onChange={(value) => setForm({ ...form, idleMinutes: Number(value) })}
        />
      </div>
      <SandboxPriceLine
        problem={problem}
        requested={requested}
        rounded={rounded}
        regionLabel={region?.label ?? null}
        fromAwakeMc={region?.fromPriceMcPerHour.awakeMc ?? null}
      />
      {creating && !create.isPending ? (
        <p
          className="text-ui-sm text-muted-foreground"
          data-testid="sandbox-create-in-flight"
        >
          A sandbox is being created…
        </p>
      ) : null}
      {/* A team's own refusal line already says it under Belongs to. */}
      <SandboxCreateFailure shown={target.refusalLine === null} />
      <SandboxCreateFooter
        askAdmin={target.askAdmin}
        canSubmit={canSubmit}
        creating={creating}
      />
    </form>
  );
}

/**
 * The form's submit, or, when the person's bundle under the team cannot pay
 * for an hour, a disabled "Ask a team admin for more capacity": nothing this
 * form can change fixes that, so the button says who can.
 */
function SandboxCreateFooter(props: {
  readonly askAdmin: boolean;
  readonly canSubmit: boolean;
  readonly creating: boolean;
}): ReactNode {
  if (props.askAdmin) {
    return (
      <DialogFooter>
        <Button type="button" disabled data-testid="sandbox-create-ask-admin">
          {SANDBOX_CREATE_ASK_ADMIN_LABEL}
        </Button>
      </DialogFooter>
    );
  }
  return (
    <DialogFooter>
      <Button
        type="submit"
        disabled={!props.canSubmit}
        data-testid="sandbox-create-submit"
      >
        {props.creating ? (
          <AgentSpinningDots
            className={undefined}
            testId="sandbox-create-spinner"
            variant={undefined}
          />
        ) : null}
        Create sandbox
      </Button>
    </DialogFooter>
  );
}

/**
 * The price line. The catalogue prices only each region's SMALLEST shape (a
 * "from" figure); the exact rate of the size chosen is the created sandbox's
 * own, shown on its card. A shape outside the catalogue replaces the line
 * with the reason, and the Create button stays disabled.
 */
function SandboxPriceLine(props: {
  readonly problem: string | null;
  readonly requested: { readonly cpus: number; readonly memoryMb: number };
  readonly rounded: { readonly cpus: number; readonly memoryMb: number };
  readonly regionLabel: string | null;
  readonly fromAwakeMc: number | null;
}): ReactNode {
  if (props.problem !== null) {
    return (
      <p
        className="text-ui-sm text-destructive"
        role="alert"
        data-testid="sandbox-create-shape-problem"
      >
        {props.problem}
      </p>
    );
  }
  const roundedNote =
    props.rounded.cpus !== props.requested.cpus ||
    props.rounded.memoryMb !== props.requested.memoryMb
      ? `Rounded to ${props.rounded.cpus} vCPU and ${formatMemory(props.rounded.memoryMb)}. `
      : "";
  return (
    <p
      className="text-ui-xs text-muted-foreground"
      data-testid="sandbox-create-price"
    >
      {props.fromAwakeMc === null || props.regionLabel === null
        ? `${roundedNote}The rate shows on the sandbox's card once it is created.`
        : `${roundedNote}From ${formatCredits(props.fromAwakeMc)} credits per hour awake in ${props.regionLabel}, for the smallest size; this size's exact rate shows on its card once it is created.`}
    </p>
  );
}

const PERSONAL_VALUE = "personal";

/** The credit gate's `reason` when the credit service could not answer. */
const UNVERIFIED_CREDIT_REASON = "unverified";

/** The team Belongs to names, or `null` for Personal (or a team gone). */
function pickedTeam(
  belongsTo: SandboxCreateBelongsTo,
  teams: readonly SandboxCreateTeam[],
): SandboxCreateTeam | null {
  if (belongsTo.kind === "personal") return null;
  return teams.find((t) => t.teamId === belongsTo.teamId) ?? null;
}

/** The form's last create: its error and what it was sent with. */
interface LastCreate {
  readonly error: Error | null;
  readonly variables: SandboxCreateSubmit | undefined;
}

/** The region and rounded size the form would create now. */
interface AskedShape {
  readonly region: SandboxCatalogueRegion | null;
  readonly shape: SandboxShape;
}

/** What a team pick allows: whether to submit, and what to say instead. */
interface TeamTarget {
  /** The team's environment, once read; `null` for Personal or while read. */
  readonly environmentId: string | null;
  /** The picked team's name, for a refusal the server leaves unnamed. */
  readonly teamName: string | null;
  /** The picked team, `null` for Personal. */
  readonly teamId: string | null;
  /** Personal, or a team whose environment has been read. */
  readonly ready: boolean;
  /** The bundle under the team cannot cover an hour (lower bound or 402). */
  readonly askAdmin: boolean;
  readonly noProviders: boolean;
  /** Why the team cannot be created into, or `null`. */
  readonly refusalLine: string | null;
}

/**
 * The reads behind a team pick: its environment (only for the picked team,
 * since the route creates the environment on its first call), then that
 * environment's providers, and the person's balance under the team.
 */
function useTeamTarget(
  team: SandboxCreateTeam | null,
  user: AuthenticatedUser | null,
  last: LastCreate,
  asked: AskedShape,
): TeamTarget {
  const environment = useTeamEnvironment(team === null ? null : team.teamId);
  const answer = team === null ? null : (environment.data ?? null);
  const environmentId = answer?.kind === "ok" ? answer.environmentId : null;
  const providers = useEnvironmentProviders(environmentId);
  const counts = providers.data?.kind === "ok" ? providers.data.counts : null;
  const refusal = refusalFor(last, environmentId);
  if (team === null) {
    return {
      environmentId: null,
      teamName: null,
      teamId: null,
      ready: true,
      askAdmin: false,
      noProviders: false,
      refusalLine: null,
    };
  }
  return {
    environmentId,
    teamName: team.name,
    teamId: team.teamId,
    // Without its environment the create would be the person's own; after
    // the server said the person is not a member, a resend is refused again
    // (the environment is read again to say why).
    ready: environmentId !== null && !refusedAsNotAMember(refusal),
    askAdmin:
      teamCannotCoverAnHour(
        teamSandboxBalanceMc(user, team.teamId),
        asked.region === null ? null : asked.region.fromPriceMcPerHour.awakeMc,
      ) ||
      (refusal !== null &&
        teamShortOfCredit(refusal) &&
        refusedThisShape(last, asked)),
    noProviders: teamHasNoProviders(counts),
    refusalLine: teamRefusalLine(
      team,
      answer,
      refusal === null ? null : refusal.code,
    ),
  };
}

/** The last create's refusal, if it was sent to this team's environment. */
function refusalFor(
  last: LastCreate,
  environmentId: string | null,
): SandboxCreateError | null {
  if (!(last.error instanceof SandboxCreateError)) return null;
  if (environmentId === null) return null;
  return last.variables?.request.environmentId === environmentId
    ? last.error
    : null;
}

/** Whether a refused create was the server saying the person left the team. */
function refusedAsNotAMember(refusal: SandboxCreateError | null): boolean {
  return (
    refusal !== null &&
    refusal.code === SANDBOX_REFUSAL_CODE_ENVIRONMENT_NOT_FOUND
  );
}

/**
 * Whether the last create asked for this region and size. A 402 answers the
 * shape it was sent for: a smaller one, or another region's price, may fit,
 * so changing either gives the submit back.
 */
function refusedThisShape(last: LastCreate, asked: AskedShape): boolean {
  const sent = last.variables?.request ?? null;
  return (
    sent !== null &&
    asked.region !== null &&
    sent.region === asked.region.id &&
    sent.cpus === asked.shape.cpus &&
    sent.memoryMb === asked.shape.memoryMb
  );
}

/**
 * Whether a refused create was the team's credit falling short. A 402 the
 * credit service could not decide (`unverified`) is a moment to try again,
 * not capacity to ask an admin for.
 */
function teamShortOfCredit(refusal: SandboxCreateError): boolean {
  return (
    refusal.code === SANDBOX_REFUSAL_CODE_INSUFFICIENT_CREDIT &&
    refusal.reason !== UNVERIFIED_CREDIT_REASON
  );
}

/** Why a picked team cannot be created into, named for it; else `null`. */
function teamRefusalLine(
  team: SandboxCreateTeam,
  answer: TeamEnvironmentFetchResult | null,
  refusalCode: string | null,
): string | null {
  if (refusalCode === SANDBOX_REFUSAL_CODE_ENVIRONMENT_NOT_FOUND) {
    return sandboxNotAMemberLine(team.name);
  }
  if (refusalCode === SANDBOX_REFUSAL_CODE_ENVIRONMENT_UNAVAILABLE) {
    return SANDBOX_CREATE_ENVIRONMENT_UNAVAILABLE_LINE;
  }
  if (answer === null || answer.kind === "ok") return null;
  if (answer.kind === "not-a-member") return sandboxNotAMemberLine(team.name);
  return SANDBOX_CREATE_ENVIRONMENT_UNAVAILABLE_LINE;
}

/**
 * Belongs to: Personal or one of the person's teams, above the name, with a
 * team pick's lines under it. Absent for a person in no team.
 */
function SandboxBelongsToField(props: {
  readonly id: string;
  readonly teams: readonly SandboxCreateTeam[];
  readonly team: SandboxCreateTeam | null;
  readonly target: TeamTarget;
  readonly onChange: (next: SandboxCreateBelongsTo) => void;
}): ReactNode {
  if (props.teams.length === 0) return null;
  return (
    <div className="flex flex-col gap-2">
      <SandboxCreateSelect
        id={props.id}
        label="Belongs to"
        // A team the person has since left reads as Personal, which is
        // what the form would create.
        value={props.team === null ? PERSONAL_VALUE : props.team.teamId}
        testId="sandbox-create-belongs-to"
        options={[
          { value: PERSONAL_VALUE, label: "Personal" },
          ...props.teams.map((t) => ({ value: t.teamId, label: t.name })),
        ]}
        onChange={(value) =>
          props.onChange(
            value === PERSONAL_VALUE
              ? { kind: "personal" }
              : { kind: "team", teamId: value },
          )
        }
      />
      {props.team === null ? null : (
        <SandboxTeamLines
          team={props.team}
          noProviders={props.target.noProviders}
          refusalLine={props.target.refusalLine}
        />
      )}
    </div>
  );
}

/**
 * A team pick's lines: the four the flows always show, then the providers
 * warning and a refusal when there is one.
 */
function SandboxTeamLines(props: {
  readonly team: SandboxCreateTeam;
  readonly noProviders: boolean;
  readonly refusalLine: string | null;
}): ReactNode {
  return (
    <div className="flex flex-col gap-1">
      <div
        className="flex flex-col gap-1 text-ui-xs text-muted-foreground"
        data-testid="sandbox-create-team-lines"
      >
        {sandboxTeamCreateLines(props.team.name).map((line) => (
          <p key={line} data-testid="sandbox-create-team-line">
            {line}
          </p>
        ))}
      </div>
      {props.noProviders ? (
        <p
          className="text-ui-xs text-warning-foreground"
          data-testid="sandbox-create-no-providers"
        >
          {sandboxNoProvidersLine(props.team.name)}
        </p>
      ) : null}
      {props.refusalLine === null ? null : (
        <p
          className="text-ui-sm text-destructive"
          role="alert"
          data-testid="sandbox-create-team-refusal"
        >
          {props.refusalLine}
        </p>
      )}
    </div>
  );
}

function SandboxCreateSelect(props: {
  readonly id: string;
  readonly label: string;
  readonly value: string;
  readonly testId: string | null;
  readonly options: readonly {
    readonly value: string;
    readonly label: string;
  }[];
  readonly onChange: (value: string) => void;
}): ReactNode {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={props.id}>{props.label}</Label>
      <Select value={props.value} onValueChange={props.onChange}>
        <SelectTrigger
          id={props.id}
          className="w-full"
          data-testid={props.testId ?? undefined}
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {props.options.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

/** Every OS some provider offers, in catalogue order. */
function offeredOses(catalogue: SandboxCatalogue): readonly SandboxOs[] {
  const seen: SandboxOs[] = [];
  for (const provider of catalogue.providers) {
    if (provider.regions.length === 0) continue;
    for (const os of provider.os) {
      if (!seen.includes(os)) seen.push(os);
    }
  }
  return seen;
}

/**
 * The provider that serves an OS: the first offering it, as the server's
 * `quoteShape` picks. Only ever called with an OS from {@link offeredOses}.
 */
function providerFor(
  catalogue: SandboxCatalogue,
  os: SandboxOs,
): SandboxCatalogueProvider {
  const provider = catalogue.providers.find(
    (candidate) => candidate.regions.length > 0 && candidate.os.includes(os),
  );
  if (provider === undefined) {
    throw new Error(`No provider offers ${os}`);
  }
  return provider;
}

/**
 * The team-task offer's success state. Mounted only after a team create succeeds, so the
 * router it navigates with is read only there.
 */
function StartTeamTaskSuccess(props: {
  readonly teamSlug: string;
  readonly hostId: string;
  readonly onDone: () => void;
}): ReactNode {
  const navigate = useNavigate();
  return (
    <SandboxCreateStartTeamTask
      teamSlug={props.teamSlug}
      onStart={() => {
        pinComposerHost(props.hostId);
        navigateToTabIntent(navigate, openNewEpicIntent(), undefined);
        props.onDone();
      }}
      onDone={props.onDone}
    />
  );
}

interface FirstTeamTaskOffer {
  readonly teamSlug: string;
  readonly hostId: string;
}

/**
 * A team sandbox created by someone with no task in that team yet ends on
 * "Start a <team> task" instead of closing; any other create closes. Read
 * from the store's `created`, so a form that remounted while the create ran
 * ends the same way.
 */
function useFirstTeamTaskOffer(
  created: SandboxCreatedLine | null,
  teams: readonly SandboxCreateTeam[],
  close: () => void,
): FirstTeamTaskOffer | null {
  const team =
    created === null || created.teamId === null
      ? null
      : (teams.find((t) => t.teamId === created.teamId) ?? null);
  const hasTeamTask = usePersonHasTeamTask(team === null ? null : team.teamId);
  const offer =
    created === null || team === null || hasTeamTask
      ? null
      : { teamSlug: team.name, hostId: created.hostId };
  const closes = created !== null && offer === null;
  useEffect(() => {
    if (closes) close();
  }, [closes, close]);
  return offer;
}
