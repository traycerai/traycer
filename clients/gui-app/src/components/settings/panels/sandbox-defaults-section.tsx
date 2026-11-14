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
import { useEnvironmentMembersList } from "@/hooks/environment/use-environment-members-list";
import { useConfigurationItemMutations } from "@/hooks/environment/team/use-configuration-item-mutations";
import { useSandboxCatalogue } from "@/hooks/sandboxes/use-sandbox-catalogue-query";
import {
  SANDBOX_DEFAULTS_KEY,
  SANDBOX_DEFAULTS_KIND,
  useConfigurationSandboxDefaults,
  type SandboxDefaultsEnvironment,
  type SandboxDefaultsRead,
} from "@/hooks/sandboxes/use-sandbox-defaults";
import { navigateToSettingsSection } from "@/lib/settings-navigation";
import {
  sandboxPeriodLabel,
  type SandboxPageConfiguration,
} from "@/lib/sandboxes/sandbox-row-lines";
import {
  configurationShapeOptions,
  configurationStageShape,
  stagePrice,
  stageProviderFor,
  stageProviderForShape,
  stageQuotedSize,
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
 * One shape option: operating system, resources, hourly rate (`from` unless
 * the catalogue prices that shape exactly) and how waking it behaves.
 */
function shapePricePart(
  catalogue: SandboxCatalogue,
  shape: StageSize,
): string | null {
  const price = stagePrice(catalogue, shape);
  if (price === null) return null;
  const label = shortPriceLabel(price.awakeMcPerHour);
  return price.exact ? label : `from ${label}`;
}

function shapeLine(catalogue: SandboxCatalogue, shape: StageSize): string {
  const provider = stageProviderFor(catalogue, shape.os);
  const wake = provider === null ? null : wakeString(provider.suspendFidelity);
  return [
    shape.os === "linux" ? "Linux" : "Windows",
    sandboxShapeLabel(shape.cpus, shape.memoryMb),
    shapePricePart(catalogue, shape),
    wake,
  ]
    .filter((part): part is string => part !== null)
    .join(" · ");
}

/** Who these defaults apply to, under the short Defaults heading. */
function defaultsScopeSentence(
  configuration: SandboxPageConfiguration,
): string {
  if (configuration.kind === "team") {
    const name = configuration.teamName;
    return `New ${name} sandboxes use these defaults. Shared by ${name}, not a spending limit. Existing sandboxes keep their Idle settings.`;
  }
  return "New Personal sandboxes use these defaults. Existing sandboxes keep their Idle settings.";
}

/** A size's option key, at the same geometry as its quote and saved defaults. */
function sizeKey(catalogue: SandboxCatalogue, size: StageSize): string {
  const provider = stageProviderForShape(catalogue, size);
  const quoted = provider === null ? null : stageQuotedSize(provider, size);
  return `${size.os}:${quoted?.shape.cpus ?? size.cpus}:${quoted?.shape.memoryMb ?? size.memoryMb}:${quoted?.shape.diskMb ?? size.diskMb ?? ""}`;
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
    environment.role === null ||
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
 * The configuration's defaults for new sandboxes: its shared
 * `sandbox_defaults` item, the built-in defaults while none is set. Editors and
 * admins change them here; readers see the people who can change them. The
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
  // mounted on its new revision still shows why the save did not land.
  const { put } = useConfigurationItemMutations();
  const issue =
    put.data === undefined ? null : configurationWriteIssue(put.data);
  return (
    <section
      aria-label="Defaults for new sandboxes"
      className="mb-6 flex flex-col gap-3"
      data-testid="sandboxes-defaults"
    >
      <h2 className="text-ui font-medium">Defaults</h2>
      <p className="text-ui-xs text-muted-foreground wrap-anywhere">
        {defaultsScopeSentence(props.configuration)}
      </p>
      {body.kind === "list" ? (
        <SandboxDefaultsList catalogue={body.catalogue} shape={body.shape} />
      ) : null}
      {environment !== null && environment.role === null ? (
        <DefaultsEditors environmentId={environment.environmentId} />
      ) : null}
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
          // A save, or a change made elsewhere, resets the form to the value read.
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
      <ConfigurationWriteFeedback issue={issue} />
    </section>
  );
}

/** Names are shown only after the complete membership read succeeds. */
function DefaultsEditors(props: { readonly environmentId: string }): ReactNode {
  const members = useEnvironmentMembersList(props.environmentId, true);
  const names =
    members.isPending || members.isError
      ? []
      : members.members.flatMap((member) =>
          member.effectiveRole !== null &&
          member.inviteState !== "pending" &&
          member.displayName !== null
            ? [member.displayName]
            : [],
        );
  let description: string;
  if (members.isPending) description = "Loading editors and admins…";
  else if (members.isError)
    description = "Couldn't read who can change defaults.";
  else
    description =
      names.length === 0
        ? "Editors and admins can change defaults."
        : `${names.join(", ")} can change defaults.`;
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2">
      <p
        className="text-ui-xs text-muted-foreground wrap-anywhere"
        data-testid="sandboxes-defaults-editors"
      >
        {description}
      </p>
      {members.isError ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={members.retry}
        >
          Retry members
        </Button>
      ) : null}
      <Button
        type="button"
        variant="link"
        size="sm"
        onClick={() => navigateToSettingsSection("members")}
      >
        Members
      </Button>
    </div>
  );
}

/** Labelled Shape, idle and destruction facts, including while they load. */
function defaultsFacts(
  catalogue: SandboxCatalogue | null,
  shape: StageShape | null,
): {
  readonly shape: string;
  readonly idle: string;
  readonly destruction: string;
} {
  if (catalogue === null || shape === null) {
    return {
      shape: catalogue === null ? "…" : SANDBOXES_CANT_BE_CREATED,
      idle: "…",
      destruction: "…",
    };
  }
  const resting = shape.destroyAfterRestingMinutes;
  return {
    shape: shapeLine(catalogue, shape),
    idle: sandboxPeriodLabel(shape.idleMinutes),
    destruction:
      resting === null || resting === 0
        ? KEPT_UNTIL_YOU_DESTROY_IT
        : `removed after ${sandboxPeriodLabel(resting)} suspended or stopped`,
  };
}

/** The defaults as labelled facts, including while the catalogue is loading. */
function SandboxDefaultsList(props: {
  readonly catalogue: SandboxCatalogue | null;
  readonly shape: StageShape | null;
}): ReactNode {
  const facts = defaultsFacts(props.catalogue, props.shape);
  return (
    <div
      className="flex min-w-0 flex-col gap-1 text-ui-sm text-muted-foreground wrap-anywhere"
      data-testid="sandboxes-defaults-summary"
    >
      <p data-testid="sandboxes-defaults-shape">{`Shape · ${facts.shape}`}</p>
      <p data-testid="sandboxes-defaults-idle">{`Idle · ${facts.idle}`}</p>
      <p data-testid="sandboxes-defaults-resting">{`Destruction · ${facts.destruction}`}</p>
    </div>
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
    return {
      problem:
        '"Destroy after suspended or stopped for" must be a whole number, or empty.',
    };
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
              <SelectValue>
                {picked === null ? null : shapeLine(catalogue, picked)}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {options.map((option) => (
                <SelectItem
                  key={sizeKey(catalogue, option)}
                  value={sizeKey(catalogue, option)}
                >
                  <span className="min-w-0 wrap-anywhere">
                    {shapeLine(catalogue, option)}
                  </span>
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
          label="Destroy after suspended or stopped for (empty: never)"
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
