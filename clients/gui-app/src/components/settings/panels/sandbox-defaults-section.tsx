import { useId, useState, type ReactNode } from "react";
import type { SandboxCatalogue } from "@traycer/protocol/host/sandbox-control";
import { configurationWriteIssue } from "@/components/settings/environment/configuration-write-issue";
import { ConfigurationWriteFeedback } from "@/components/settings/environment/configuration-write-feedback";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useConfigurationItemMutations } from "@/hooks/environment/team/use-configuration-item-mutations";
import { useEnvironmentMembersList } from "@/hooks/environment/use-environment-members-list";
import { useSandboxCatalogue } from "@/hooks/sandboxes/use-sandbox-catalogue-query";
import {
  SANDBOX_DEFAULTS_KEY,
  SANDBOX_DEFAULTS_KIND,
  useConfigurationSandboxDefaults,
  type SandboxDefaultsEnvironment,
  type SandboxDefaultsRead,
} from "@/hooks/sandboxes/use-sandbox-defaults";
import { useHostClient } from "@/lib/host";
import {
  sandboxPeriodLabel,
  type SandboxPageConfiguration,
} from "@/lib/sandboxes/sandbox-row-lines";
import {
  configurationShapeOptions,
  configurationStageShape,
  stagePrice,
  stageProviderFor,
  stageShapeDefaults,
  type SandboxConfigurationDefaults,
  type StageShape,
  type StageSize,
} from "@/lib/sandboxes/sandbox-stage-model";
import {
  KEPT_UNTIL_YOU_DESTROY_IT,
  SANDBOXES_CANT_BE_CREATED,
  sandboxShapeLabel,
  shortPriceLabel,
  wakeString,
} from "@/lib/sandboxes/sandbox-strings";

/** The idle period's floor, refused below, never clamped. */
const IDLE_FLOOR_MINUTES = 2;

type PeriodUnit = "minutes" | "hours" | "days";

const UNIT_MINUTES: Record<PeriodUnit, number> = {
  minutes: 1,
  hours: 60,
  days: 24 * 60,
};

/** The key a configuration's environment is listed under: `personal` or the team id. */
function configurationEnvironmentKey(
  configuration: SandboxPageConfiguration,
): string {
  return configuration.kind === "team" ? configuration.teamId : "personal";
}

/**
 * A shape as the catalogue offers it, with its class's wake string and its
 * price (`from` unless it is the region's smallest, the one shape the
 * catalogue prices).
 */
function shapeLine(catalogue: SandboxCatalogue, shape: StageSize): string {
  const provider = stageProviderFor(catalogue, shape.os);
  const price = stagePrice(catalogue, shape);
  const priceLabel =
    price === null ? null : shortPriceLabel(price.awakeMcPerHour);
  return [
    `${shape.os === "linux" ? "Linux" : "Windows"} · ${sandboxShapeLabel(shape.cpus, shape.memoryMb)}`,
    price === null || price.exact ? priceLabel : `from ${priceLabel}`,
    provider === null ? null : wakeString(provider.suspendFidelity),
  ]
    .filter((part): part is string => part !== null)
    .join(" · ");
}

/** A size's option key; an unset disk is the provider's default. */
function sizeKey(catalogue: SandboxCatalogue, size: StageSize): string {
  const disk =
    size.diskMb ?? stageProviderFor(catalogue, size.os)?.shape.diskDefaultMb;
  return `${size.os}:${size.cpus}:${size.memoryMb}:${disk ?? ""}`;
}

/**
 * What the card shows: the form for one who may edit, else the list, and
 * neither while the item could not be read (the card says so, with Retry).
 */
type DefaultsCardBody =
  | { readonly kind: "unread" }
  | {
      readonly kind: "form";
      readonly catalogue: SandboxCatalogue;
      readonly environmentId: string;
      readonly revision: number | null;
      readonly shape: StageShape;
    }
  | {
      readonly kind: "list";
      /** `null` while the catalogue or the item is read. */
      readonly catalogue: SandboxCatalogue | null;
      readonly shape: StageShape | null;
    };

function defaultsCardBody(
  catalogue: SandboxCatalogue | null,
  environment: SandboxDefaultsEnvironment | null,
  read: SandboxDefaultsRead | null,
): DefaultsCardBody {
  if (read !== null && read.kind === "failed") return { kind: "unread" };
  if (catalogue === null || (read !== null && read.kind === "pending")) {
    return { kind: "list", catalogue: null, shape: null };
  }
  const ready = read === null ? null : read.value;
  const shape = configurationStageShape(catalogue, ready?.defaults ?? null);
  if (
    environment === null ||
    environment.role === "viewer" ||
    ready === null ||
    shape === null
  ) {
    return { kind: "list", catalogue, shape };
  }
  return {
    kind: "form",
    catalogue,
    environmentId: environment.environmentId,
    revision: ready.revision,
    shape,
  };
}

/**
 * The configuration's defaults for new sandboxes (Flow 6's card): its shared
 * `sandbox_defaults` item, the spec's defaults while none is set. Editors and
 * admins change them here; a viewer reads them with the people who can. The
 * gear on a New row changes one sandbox only and never shows here.
 */
export function SandboxDefaultsSection(props: {
  readonly configuration: SandboxPageConfiguration;
}): ReactNode {
  const catalogue = useSandboxCatalogue(true).data ?? null;
  const { environment, read } = useConfigurationSandboxDefaults(
    configurationEnvironmentKey(props.configuration),
  );
  const body = defaultsCardBody(catalogue, environment, read);
  // Held here, not in the form: a conflict rereads the item, and the form
  // reopened on its new revision still shows why the save did not land.
  const { put } = useConfigurationItemMutations();
  const issue =
    put.data === undefined ? null : configurationWriteIssue(put.data);
  return (
    <section
      aria-label="Defaults for new sandboxes"
      className="flex flex-col gap-3 border-b border-border/60 px-5 py-4"
      data-testid="sandboxes-defaults"
    >
      <DefaultsHeading
        configuration={props.configuration}
        environment={environment}
      />
      {read !== null && read.kind === "failed" ? (
        <div className="flex flex-wrap items-center gap-2">
          <p role="status" className="text-ui-sm text-muted-foreground">
            Couldn&apos;t read these defaults.
          </p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={read.retry}
          >
            Retry
          </Button>
        </div>
      ) : null}
      {body.kind === "form" ? (
        <SandboxDefaultsForm
          // A save, or a change made elsewhere, reopens the form on the value read.
          key={`${body.revision ?? "none"}`}
          catalogue={body.catalogue}
          initialShape={body.shape}
          saving={put.isPending}
          onSave={(defaults) => {
            put.mutate({
              environmentId: body.environmentId,
              kind: SANDBOX_DEFAULTS_KIND,
              key: SANDBOX_DEFAULTS_KEY,
              os: null,
              value: { ...defaults },
              revision: body.revision,
            });
          }}
        />
      ) : null}
      {body.kind === "list" ? (
        <SandboxDefaultsList catalogue={body.catalogue} shape={body.shape} />
      ) : null}
      <ConfigurationWriteFeedback issue={issue} />
    </section>
  );
}

const KEPT_UNTIL_IDLE_CHANGED =
  "Sandboxes you already have aren't destroyed after resting until you change their Idle settings.";

function DefaultsHeading(props: {
  readonly configuration: SandboxPageConfiguration;
  readonly environment: SandboxDefaultsEnvironment | null;
}): ReactNode {
  const { configuration } = props;
  if (configuration.kind === "personal") {
    return (
      <div className="min-w-0 space-y-1">
        <h2 className="text-ui font-medium">Your defaults for new sandboxes</h2>
        <p className="text-ui-xs text-muted-foreground">
          {`Each new Personal sandbox starts with these. ${KEPT_UNTIL_IDLE_CHANGED}`}
        </p>
      </div>
    );
  }
  return (
    <div className="min-w-0 space-y-1">
      <h2 className="text-ui font-medium">
        {`${configuration.teamName}'s defaults for new sandboxes`}
      </h2>
      <p className="text-ui-xs text-muted-foreground">
        {`Shared by ${configuration.teamName} · `}
        <EditorsClause environment={props.environment} />
        {` · not a spending limit. Each new ${configuration.teamName} sandbox starts with these. ${KEPT_UNTIL_IDLE_CHANGED}`}
      </p>
    </div>
  );
}

/**
 * Who can change a team's defaults: `editors can change them` for one who
 * can, and for a viewer the editors and admins by name once the roster has
 * answered.
 */
function EditorsClause(props: {
  readonly environment: SandboxDefaultsEnvironment | null;
}): ReactNode {
  const viewerEnvironmentId =
    props.environment !== null && props.environment.role === "viewer"
      ? props.environment.environmentId
      : null;
  const members = useEnvironmentMembersList(
    useHostClient(),
    viewerEnvironmentId,
    viewerEnvironmentId !== null,
  );
  const names =
    viewerEnvironmentId === null || members.isPending || members.isError
      ? []
      : members.members.flatMap((member) =>
          member.effectiveRole !== "viewer" &&
          member.inviteState !== "pending" &&
          member.displayName !== null
            ? [member.displayName]
            : [],
        );
  return (
    <span data-testid="sandboxes-defaults-editors">
      {names.length === 0
        ? "editors can change them"
        : `${names.join(", ")} can change them`}
    </span>
  );
}

/** The defaults as text: a viewer's, and anyone's while they are read (`catalogue` null). */
function SandboxDefaultsList(props: {
  readonly catalogue: SandboxCatalogue | null;
  readonly shape: StageShape | null;
}): ReactNode {
  const { catalogue, shape } = props;
  let shapeText = "…";
  if (catalogue !== null) {
    shapeText =
      shape === null ? SANDBOXES_CANT_BE_CREATED : shapeLine(catalogue, shape);
  }
  let idleText = "…";
  let restingText = "…";
  if (shape !== null) {
    idleText = sandboxPeriodLabel(shape.idleMinutes);
    restingText =
      shape.destroyAfterRestingMinutes === null
        ? KEPT_UNTIL_YOU_DESTROY_IT
        : sandboxPeriodLabel(shape.destroyAfterRestingMinutes);
  }
  return (
    <dl className="grid grid-cols-1 gap-x-4 gap-y-1 text-ui-sm sm:grid-cols-[auto_1fr]">
      <dt className="text-muted-foreground">Shape</dt>
      <dd data-testid="sandboxes-defaults-shape">{shapeText}</dd>
      <dt className="text-muted-foreground">
        Suspend when idle for (at least 2 minutes)
      </dt>
      <dd data-testid="sandboxes-defaults-idle">{idleText}</dd>
      <dt className="text-muted-foreground">
        Destroy after resting for (empty: never)
      </dt>
      <dd data-testid="sandboxes-defaults-resting">{restingText}</dd>
    </dl>
  );
}

interface PeriodField {
  readonly amount: string;
  readonly unit: PeriodUnit;
}

function periodField(minutes: number | null): PeriodField {
  if (minutes === null) return { amount: "", unit: "days" };
  if (minutes % UNIT_MINUTES.days === 0) {
    return { amount: String(minutes / UNIT_MINUTES.days), unit: "days" };
  }
  if (minutes % UNIT_MINUTES.hours === 0) {
    return { amount: String(minutes / UNIT_MINUTES.hours), unit: "hours" };
  }
  return { amount: String(minutes), unit: "minutes" };
}

/** A period's minutes; `null` for an empty field, `NaN` for one that does not parse. */
function periodMinutes(field: PeriodField): number | null {
  if (field.amount.trim().length === 0) return null;
  const amount = Number(field.amount);
  if (!Number.isInteger(amount) || amount <= 0) return Number.NaN;
  return amount * UNIT_MINUTES[field.unit];
}

/** The form's defaults, or why they are not ones a save may write. */
function defaultsOfForm(
  catalogue: SandboxCatalogue,
  picked: StageSize | null,
  idle: PeriodField,
  resting: PeriodField,
):
  | { readonly defaults: SandboxConfigurationDefaults }
  | { readonly problem: string } {
  if (picked === null) return { problem: "Pick a shape." };
  const idleMinutes = periodMinutes(idle);
  if (
    idleMinutes === null ||
    Number.isNaN(idleMinutes) ||
    idleMinutes < IDLE_FLOOR_MINUTES
  ) {
    return {
      problem: `Idle period must be at least ${IDLE_FLOOR_MINUTES} minutes.`,
    };
  }
  const restingMinutes = periodMinutes(resting);
  if (restingMinutes !== null && Number.isNaN(restingMinutes)) {
    return { problem: "Resting period must be a whole number, or empty." };
  }
  const defaults = stageShapeDefaults(catalogue, {
    ...picked,
    idleMinutes,
    destroyAfterRestingMinutes: restingMinutes,
  });
  return defaults === null ? { problem: "Pick a shape." } : { defaults };
}

function SandboxDefaultsForm(props: {
  readonly catalogue: SandboxCatalogue;
  readonly initialShape: StageShape;
  readonly saving: boolean;
  readonly onSave: (defaults: SandboxConfigurationDefaults) => void;
}): ReactNode {
  const ids = useId();
  const { catalogue, initialShape } = props;
  const options = configurationShapeOptions(catalogue);
  const initialKey = sizeKey(catalogue, initialShape);
  const [size, setSize] = useState(initialKey);
  const [idle, setIdle] = useState(periodField(initialShape.idleMinutes));
  const [resting, setResting] = useState(
    periodField(initialShape.destroyAfterRestingMinutes),
  );
  const picked =
    options.find((option) => sizeKey(catalogue, option) === size) ?? null;
  const result = defaultsOfForm(catalogue, picked, idle, resting);
  const changed =
    size !== initialKey ||
    periodMinutes(idle) !== initialShape.idleMinutes ||
    periodMinutes(resting) !== initialShape.destroyAfterRestingMinutes;
  return (
    <form
      noValidate
      className="flex flex-col gap-3"
      data-testid="sandboxes-defaults-form"
      onSubmit={(event) => {
        event.preventDefault();
        if ("defaults" in result) props.onSave(result.defaults);
      }}
    >
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5 sm:col-span-2">
          <Label htmlFor={`${ids}-shape`}>Shape</Label>
          <Select value={size} onValueChange={setSize}>
            <SelectTrigger
              id={`${ids}-shape`}
              className="w-full"
              data-testid="sandboxes-defaults-shape-select"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {options.map((option) => (
                <SelectItem
                  key={sizeKey(catalogue, option)}
                  value={sizeKey(catalogue, option)}
                >
                  {shapeLine(catalogue, option)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <PeriodInput
          id={`${ids}-idle`}
          label="Suspend when idle for (at least 2 minutes)"
          placeholder={null}
          field={idle}
          testId="sandboxes-defaults-idle-input"
          onChange={setIdle}
        />
        <PeriodInput
          id={`${ids}-resting`}
          label="Destroy after resting for (empty: never)"
          placeholder="Never"
          field={resting}
          testId="sandboxes-defaults-resting-input"
          onChange={setResting}
        />
      </div>
      {"problem" in result && changed ? (
        <p
          className="m-0 text-ui-sm text-destructive"
          role="alert"
          data-testid="sandboxes-defaults-problem"
        >
          {result.problem}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="submit"
          size="sm"
          disabled={!changed || !("defaults" in result) || props.saving}
          data-testid="sandboxes-defaults-save"
        >
          Save defaults
          {props.saving ? (
            <AgentSpinningDots
              className={undefined}
              testId="sandboxes-defaults-saving"
              variant={undefined}
              tone="muted"
            />
          ) : null}
        </Button>
      </div>
    </form>
  );
}

function PeriodInput(props: {
  readonly id: string;
  readonly label: string;
  readonly placeholder: string | null;
  readonly field: PeriodField;
  readonly testId: string;
  readonly onChange: (field: PeriodField) => void;
}): ReactNode {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={props.id}>{props.label}</Label>
      <div className="flex gap-2">
        <Input
          id={props.id}
          type="number"
          inputMode="numeric"
          min={1}
          value={props.field.amount}
          placeholder={props.placeholder ?? undefined}
          data-testid={props.testId}
          onChange={(event) =>
            props.onChange({ ...props.field, amount: event.target.value })
          }
        />
        <Select
          value={props.field.unit}
          onValueChange={(value) => {
            if (value === "minutes" || value === "hours" || value === "days") {
              props.onChange({ ...props.field, unit: value });
            }
          }}
        >
          <SelectTrigger aria-label={`${props.label} unit`}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="minutes">minutes</SelectItem>
            <SelectItem value="hours">hours</SelectItem>
            <SelectItem value="days">days</SelectItem>
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}
