import { useId, useState, type ReactNode } from "react";
import { toast } from "sonner";
import type {
  SandboxCatalogue,
  SandboxCatalogueProvider,
  SandboxOs,
} from "@traycer/protocol/host/sandbox-control";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
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
import { useSandboxCatalogue } from "@/hooks/sandboxes/use-sandbox-catalogue-query";
import { useSandboxCreate } from "@/hooks/sandboxes/use-sandbox-create-mutation";
import {
  formatCredits,
  formatMemory,
  roundSandboxShape,
  sandboxShapeProblem,
} from "@/lib/sandboxes/sandbox-pricing";
import { useSandboxCreateDialogStore } from "@/stores/settings/sandbox-create-dialog-store";

const MB_PER_GIB = 1024;
const NAME_MAX_LENGTH = 191;

/**
 * Idle periods the form offers, in minutes. The server takes 1 minute to one
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
 * Creating a sandbox from Settings: OS, a free-form size within the
 * catalogue's bounds, region, idle period and name, from
 * `GET /api/sandboxes/catalogue`. Mounted once beside the add-host dialog and
 * opened through its store.
 */
export function SandboxCreateDialog(): ReactNode {
  const open = useSandboxCreateDialogStore((s) => s.open);
  const closeDialog = useSandboxCreateDialogStore((s) => s.closeDialog);
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
        {open ? <SandboxCreateDialogBody onDone={closeDialog} /> : null}
      </DialogContent>
    </Dialog>
  );
}

function SandboxCreateDialogBody(props: {
  readonly onDone: () => void;
}): ReactNode {
  const catalogue = useSandboxCatalogue(true);
  if (catalogue.isPending) {
    return (
      <div className="flex items-center gap-2 text-ui-sm text-muted-foreground">
        <AgentSpinningDots
          className={undefined}
          testId="sandbox-create-loading"
          variant={undefined}
        />
        Loading sizes and regions…
      </div>
    );
  }
  if (catalogue.isError) {
    return (
      <div className="flex flex-col items-start gap-2">
        <p className="text-ui-sm text-muted-foreground">
          {catalogue.error.message}
        </p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => void catalogue.refetch()}
        >
          Try again
        </Button>
      </div>
    );
  }
  const offered = offeredOses(catalogue.data);
  if (offered.length === 0) {
    return (
      <p className="text-ui-sm text-muted-foreground">
        Sandboxes aren&apos;t offered right now.
      </p>
    );
  }
  return (
    <SandboxCreateForm
      catalogue={catalogue.data}
      initialOs={offered[0]}
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

function initialFormState(
  provider: SandboxCatalogueProvider,
  os: SandboxOs,
): SandboxFormState {
  const { shape } = provider;
  const memoryMb = Math.max(
    shape.memoryMinMb,
    shape.cpuMin * shape.memoryPerCpuMinMb,
  );
  return {
    name: "",
    os,
    cpus: String(shape.cpuMin),
    memoryGb: String(memoryMb / MB_PER_GIB),
    // The server's own default: its first priced region.
    region: provider.regions.at(0)?.id ?? "",
    idleMinutes: DEFAULT_IDLE_MINUTES,
  };
}

function SandboxCreateForm(props: {
  readonly catalogue: SandboxCatalogue;
  readonly initialOs: SandboxOs;
  readonly onDone: () => void;
}): ReactNode {
  const ids = useId();
  const [form, setForm] = useState<SandboxFormState>(() =>
    initialFormState(
      providerFor(props.catalogue, props.initialOs),
      props.initialOs,
    ),
  );
  const create = useSandboxCreate();
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
  const canSubmit =
    problem === null && region !== null && name.length > 0 && !create.isPending;

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
        create.mutate(
          {
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
          },
          {
            onSuccess: () => {
              toast.success(`Created ${name}`);
              props.onDone();
            },
          },
        );
      }}
    >
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
        <SandboxCreateSelect
          id={`${ids}-os`}
          label="Operating system"
          value={form.os}
          options={offeredOses(props.catalogue).map((os) => ({
            value: os,
            label: OS_LABEL[os],
          }))}
          onChange={(value) => {
            const os = offeredOses(props.catalogue).find((o) => o === value);
            if (os === undefined) return;
            setForm({
              ...initialFormState(providerFor(props.catalogue, os), os),
              name: form.name,
              idleMinutes: form.idleMinutes,
            });
          }}
        />
        <SandboxCreateSelect
          id={`${ids}-region`}
          label="Region"
          value={region?.id ?? ""}
          options={provider.regions.map((candidate) => ({
            value: candidate.id,
            label: candidate.label,
          }))}
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
      <DialogFooter>
        <Button
          type="submit"
          disabled={!canSubmit}
          data-testid="sandbox-create-submit"
        >
          {create.isPending ? (
            <AgentSpinningDots
              className={undefined}
              testId="sandbox-create-spinner"
              variant={undefined}
            />
          ) : null}
          Create sandbox
        </Button>
      </DialogFooter>
    </form>
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

function SandboxCreateSelect(props: {
  readonly id: string;
  readonly label: string;
  readonly value: string;
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
        <SelectTrigger id={props.id} className="w-full">
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
