import { stagedSandboxName } from "@/lib/sandboxes/staged-sandbox-name";
import { useId, useRef, useState, type ReactNode } from "react";
import type {
  SandboxCatalogue,
  SandboxCatalogueProvider,
  SandboxOs,
  SandboxShapeRung,
} from "@traycer/protocol/host/sandbox-control";
import { AddCreditsLink } from "@/components/composer/consequences-block";
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
import { declineListSearchAutoFocus } from "@/hooks/ui/decline-list-search-autofocus";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useAuthUser } from "@/hooks/auth/use-auth-user-query";
import { useTeamBundleBalances } from "@/hooks/sandboxes/use-team-bundle-balances";
import { useSandboxCatalogue } from "@/hooks/sandboxes/use-sandbox-catalogue-query";
import { useSandboxGetReadiness } from "@/hooks/sandboxes/use-sandbox-get-readiness-query";
import {
  formatMemory,
  roundSandboxShape,
  sandboxShapeProblem,
} from "@/lib/sandboxes/sandbox-pricing";
import {
  consequenceClauses,
  defaultShapeRung,
  rememberedOrConfigurationStageShape,
  selectableStageRungs,
  stageBalanceMc,
  stageConfigurationCopy,
  stageCreditShortfallMc,
  stageNeedsCredits,
  stagePrice,
  stageProviderFor,
  stageQuotedSize,
  stageRungForSize,
  type ConsequencesInput,
  type SandboxConfigurationDefaults,
  type StageConfiguration,
  type StageShape,
} from "@/lib/sandboxes/sandbox-stage-model";
import {
  SANDBOXES_CANT_BE_CREATED,
  CHANGE_LABEL,
  SANDBOX_REGION_LABEL,
  SHAPE_SHEET_DESCRIPTION,
  USE_THIS_SHAPE,
  WINDOWS_SANDBOX_LIMITATION,
  idleAndRestingLine,
  newSandboxRowLabel,
  sandboxShapeLabel,
  sandboxSizeLabel,
  shortAwakePriceLabel,
  shortPriceLabel,
  wakeString,
} from "@/lib/sandboxes/sandbox-strings";

const MB_PER_GIB = 1024;
const NAME_MAX_LENGTH = 191;
/** The idle period's floor, refused below, never clamped. */
const IDLE_FLOOR_MINUTES = 2;

const OS_LABEL: Record<SandboxOs, string> = {
  linux: "Linux",
  windows: "Windows",
};

type RestingUnit = "minutes" | "hours" | "days";

const UNIT_MINUTES: Record<RestingUnit, number> = {
  minutes: 1,
  hours: 60,
  days: 24 * 60,
};

/** What the sheet repeats of the block: everything but what it computes. */
export type ShapeSheetContext = Pick<
  ConsequencesInput,
  "audience" | "reachHost" | "unmovedComputer"
>;

/**
 * The New row's gear (and the staged chip's): the staged create's shape,
 * name, region and idle and resting periods, with its price and the
 * consequences block repeated. `Use this shape` writes the stage and the
 * person's remembered pick for this configuration; nothing is created, and
 * the configuration's shared defaults are never written from here.
 */
export function SandboxShapeSheet(props: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly configuration: StageConfiguration;
  /** The configuration's defaults, `null` for none: what an unset gear opens on. */
  readonly defaults: SandboxConfigurationDefaults | null;
  /**
   * The staged shape, else the person's remembered one; `null`, or one the
   * catalogue no longer offers, opens on the configuration's defaults.
   */
  readonly initialShape: StageShape | null;
  readonly initialName: string;
  readonly context: ShapeSheetContext;
  readonly onUseShape: (
    shape: StageShape,
    name: string,
    wakeString: string | null,
  ) => void;
}): ReactNode {
  const copy = stageConfigurationCopy(props.configuration);
  const returnFocus = useRef<HTMLElement | null>(null);
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent
        className="flex w-[min(92vw,30rem)] flex-col sm:max-w-[min(92vw,30rem)]"
        data-testid="sandbox-shape-sheet"
        onOpenAutoFocus={(event) => {
          returnFocus.current =
            document.activeElement instanceof HTMLElement
              ? document.activeElement
              : null;
          declineListSearchAutoFocus(event);
        }}
        onCloseAutoFocus={(event) => {
          if (returnFocus.current?.isConnected) {
            event.preventDefault();
            returnFocus.current.focus();
          }
        }}
      >
        <DialogHeader>
          <DialogTitle>{newSandboxRowLabel(copy)}</DialogTitle>
        </DialogHeader>
        {props.open ? <ShapeSheetBody {...props} /> : null}
      </DialogContent>
    </Dialog>
  );
}

function ShapeSheetBody(props: {
  readonly onOpenChange: (open: boolean) => void;
  readonly configuration: StageConfiguration;
  readonly defaults: SandboxConfigurationDefaults | null;
  readonly initialShape: StageShape | null;
  readonly initialName: string;
  readonly context: ShapeSheetContext;
  readonly onUseShape: (
    shape: StageShape,
    name: string,
    wakeString: string | null,
  ) => void;
}): ReactNode {
  const catalogue = useSandboxCatalogue(true);
  if (catalogue.isPending) {
    return (
      <div className="flex items-center gap-2 text-ui-sm text-muted-foreground">
        <AgentSpinningDots
          className={undefined}
          testId="sandbox-shape-sheet-loading"
          variant={undefined}
        />
        <DialogDescription>Loading sizes and regions…</DialogDescription>
      </div>
    );
  }
  if (catalogue.isError) {
    return (
      <div className="flex flex-col items-start gap-2">
        <DialogDescription>{catalogue.error.message}</DialogDescription>
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
  const shape = rememberedOrConfigurationStageShape(
    catalogue.data,
    props.initialShape,
    props.defaults,
  );
  if (shape === null) {
    return <DialogDescription>{SANDBOXES_CANT_BE_CREATED}</DialogDescription>;
  }
  return (
    <>
      <DialogDescription>{SHAPE_SHEET_DESCRIPTION}</DialogDescription>
      <ShapeSheetForm
        catalogue={catalogue.data}
        initialShape={shape}
        initialName={props.initialName}
        configuration={props.configuration}
        context={props.context}
        onCancel={() => props.onOpenChange(false)}
        onUseShape={(next, name, wake) => {
          props.onUseShape(next, name, wake);
          props.onOpenChange(false);
        }}
      />
    </>
  );
}

interface ShapeForm {
  readonly name: string;
  readonly os: SandboxOs;
  readonly cpus: string;
  readonly memoryGb: string;
  readonly diskGb: string;
  /** Disk to restore after a fixed rung uses its listed disk. */
  readonly growingDiskGb: string;
  readonly region: string;
  readonly idleMinutes: string;
  /** Empty: kept until it is destroyed. */
  readonly restingAmount: string;
  readonly restingUnit: RestingUnit;
}

function restingFields(
  minutes: number | null,
): Pick<ShapeForm, "restingAmount" | "restingUnit"> {
  if (minutes === null) return { restingAmount: "", restingUnit: "days" };
  if (minutes % UNIT_MINUTES.days === 0) {
    return {
      restingAmount: String(minutes / UNIT_MINUTES.days),
      restingUnit: "days",
    };
  }
  if (minutes % UNIT_MINUTES.hours === 0) {
    return {
      restingAmount: String(minutes / UNIT_MINUTES.hours),
      restingUnit: "hours",
    };
  }
  return { restingAmount: String(minutes), restingUnit: "minutes" };
}

function formOf(
  shape: StageShape,
  name: string,
  provider: SandboxCatalogueProvider,
): ShapeForm {
  const size = stageQuotedSize(provider, shape)?.shape;
  return {
    name,
    os: shape.os,
    cpus: String(size?.cpus ?? shape.cpus),
    memoryGb: String((size?.memoryMb ?? shape.memoryMb) / MB_PER_GIB),
    diskGb: size === undefined ? "" : String(size.diskMb / MB_PER_GIB),
    growingDiskGb: "",
    region: shape.region,
    idleMinutes: String(shape.idleMinutes),
    ...restingFields(shape.destroyAfterRestingMinutes),
  };
}

/** The size fields of a listed shape. */
function rungFields(
  rung: SandboxShapeRung,
): Pick<ShapeForm, "cpus" | "memoryGb" | "diskGb"> {
  return {
    cpus: String(rung.cpus),
    memoryGb: String(rung.memoryMb / MB_PER_GIB),
    diskGb: String(rung.diskMb / MB_PER_GIB),
  };
}

/**
 * The form's disk in MB, or why it is outside the provider's bounds. A blank
 * field reads as 0, which every catalogue's positive minimum refuses.
 */
function diskOfForm(
  diskGbInput: string,
  provider: SandboxCatalogueProvider,
): { readonly diskMb: number } | { readonly problem: string } {
  const diskGb = Number(diskGbInput);
  const diskMb = diskGb * MB_PER_GIB;
  if (
    !Number.isInteger(diskGb) ||
    diskMb < provider.shape.diskMinMb ||
    diskMb > provider.shape.diskMaxMb
  ) {
    return {
      problem: `Disk must be between ${provider.shape.diskMinMb / MB_PER_GIB} and ${provider.shape.diskMaxMb / MB_PER_GIB} GB.`,
    };
  }
  return { diskMb };
}

/** The disk a size option will use when selected. */
function diskGbForRung(
  form: ShapeForm,
  provider: SandboxCatalogueProvider,
  rung: SandboxShapeRung,
  selectedRungGrows: boolean,
): string {
  const listedDiskGb = String(rung.diskMb / MB_PER_GIB);
  if (rung.grows === undefined) return listedDiskGb;
  const chosenDiskGb = selectedRungGrows ? form.diskGb : form.growingDiskGb;
  if (!selectedRungGrows && "problem" in diskOfForm(chosenDiskGb, provider)) {
    return listedDiskGb;
  }
  // A remembered disk can name a fixed sibling of the growing option.
  const selected = stageRungForSize(provider.shapes ?? [], {
    cpus: rung.cpus,
    memoryMb: rung.memoryMb,
    diskMb: Number(chosenDiskGb) * MB_PER_GIB,
  });
  return selected !== null && selected.grows === undefined
    ? listedDiskGb
    : chosenDiskGb;
}

function rungKey(rung: SandboxShapeRung): string {
  const kind = rung.grows === undefined ? "fixed" : "growing";
  return `${rung.cpus}:${rung.memoryMb}:${rung.diskMb}:${kind}`;
}

function selectableFormRungs(
  shapes: readonly SandboxShapeRung[] | null,
  selected: SandboxShapeRung | null,
): readonly SandboxShapeRung[] | null {
  if (shapes === null) return null;
  const rungs = selectableStageRungs(shapes);
  // A resized growing start can still be selected when its listed disk names a fixed sibling.
  return selected === null || rungs.includes(selected)
    ? rungs
    : [...rungs, selected];
}

function resolveRung(
  form: ShapeForm,
  shapes: readonly SandboxShapeRung[] | null,
): {
  readonly rung: SandboxShapeRung | null;
  readonly value: string;
  readonly grows: boolean;
} {
  const rung = stageRungForSize(shapes ?? [], {
    cpus: Number(form.cpus),
    memoryMb: Math.round(Number(form.memoryGb) * MB_PER_GIB),
    diskMb: Number(form.diskGb) * MB_PER_GIB,
  });
  return {
    rung,
    value: rung === null ? "" : rungKey(rung),
    grows: rung?.grows !== undefined,
  };
}

type FormSize = Pick<StageShape, "cpus" | "memoryMb" | "diskMb">;

/**
 * The form's size: an exact rung, or a free-form request within bounds.
 * CPU and memory are rounded here; disk remains a request whose allocated
 * geometry is read through `stageQuotedSize` by pricing and readiness.
 */
function sizeOfForm(
  form: ShapeForm,
  provider: SandboxCatalogueProvider,
  rung: SandboxShapeRung | null,
): { readonly size: FormSize } | { readonly problem: string } {
  if (provider.shapes !== null) {
    if (rung === null) return { problem: "Pick a size." };
    if (rung.grows === undefined) {
      return {
        size: { cpus: rung.cpus, memoryMb: rung.memoryMb, diskMb: rung.diskMb },
      };
    }
    const disk = diskOfForm(form.diskGb, provider);
    if ("problem" in disk) return disk;
    return {
      size: { cpus: rung.cpus, memoryMb: rung.memoryMb, diskMb: disk.diskMb },
    };
  }
  const requested = {
    cpus: Number(form.cpus),
    memoryMb: Math.round(Number(form.memoryGb) * MB_PER_GIB),
  };
  const problem = sandboxShapeProblem(provider.shape, requested);
  if (problem !== null) return { problem };
  const diskMb = Math.round(Number(form.diskGb) * MB_PER_GIB);
  if (
    !Number.isFinite(diskMb) ||
    diskMb < provider.shape.diskMinMb ||
    diskMb > provider.shape.diskMaxMb
  ) {
    return {
      problem: `Disk must be between ${provider.shape.diskMinMb / MB_PER_GIB} and ${provider.shape.diskMaxMb / MB_PER_GIB} GB.`,
    };
  }
  const rounded = roundSandboxShape(provider.shape, requested);
  return {
    size: {
      cpus: rounded.cpus,
      memoryMb: rounded.memoryMb,
      diskMb: diskMb === provider.shape.diskDefaultMb ? null : diskMb,
    },
  };
}

/** The form's shape, or why it is not one the catalogue offers. */
function shapeOfForm(
  form: ShapeForm,
  provider: SandboxCatalogueProvider,
  rung: SandboxShapeRung | null,
): { readonly shape: StageShape } | { readonly problem: string } {
  const sized = sizeOfForm(form, provider, rung);
  if ("problem" in sized) return sized;
  const idleMinutes = Number(form.idleMinutes);
  if (!Number.isInteger(idleMinutes) || idleMinutes < IDLE_FLOOR_MINUTES) {
    return {
      problem: `Idle period must be at least ${IDLE_FLOOR_MINUTES} minutes.`,
    };
  }
  let destroyAfterRestingMinutes: number | null = null;
  if (form.restingAmount.trim().length > 0) {
    const amount = Number(form.restingAmount);
    if (!Number.isInteger(amount) || amount <= 0) {
      return {
        problem:
          '"Destroyed after suspended or stopped for" must be a whole number, or empty.',
      };
    }
    destroyAfterRestingMinutes = amount * UNIT_MINUTES[form.restingUnit];
  }
  return {
    shape: {
      os: form.os,
      ...sized.size,
      region: form.region,
      idleMinutes,
      destroyAfterRestingMinutes,
    },
  };
}

function ShapeSheetForm(props: {
  readonly catalogue: SandboxCatalogue;
  readonly initialShape: StageShape;
  readonly initialName: string;
  readonly configuration: StageConfiguration;
  readonly context: ShapeSheetContext;
  readonly onCancel: () => void;
  readonly onUseShape: (
    shape: StageShape,
    name: string,
    wakeString: string | null,
  ) => void;
}): ReactNode {
  const ids = useId();
  const user = useAuthUser().data ?? null;
  const teamBalanceMc = useTeamBundleBalances();
  const [form, setForm] = useState<ShapeForm>(() => {
    const provider = stageProviderFor(props.catalogue, props.initialShape.os);
    const name = stagedSandboxName(props.initialName);
    return provider === null
      ? formOf(props.initialShape, name, props.catalogue.providers[0])
      : formOf(props.initialShape, name, provider);
  });
  const [periodsOpen, setPeriodsOpen] = useState(false);
  const [sizeCommitted, setSizeCommitted] = useState(true);
  const provider = stageProviderFor(props.catalogue, form.os);
  if (provider === null) {
    return (
      <p className="text-ui-sm text-muted-foreground">
        That operating system isn&apos;t offered yet.
      </p>
    );
  }
  const selection = resolveRung(form, provider.shapes);
  const selectedRungGrows = selection.grows;
  const selectableRungs = selectableFormRungs(provider.shapes, selection.rung);
  const result = shapeOfForm(form, provider, selection.rung);
  const shape = "shape" in result ? result.shape : null;
  const price = shape === null ? null : stagePrice(props.catalogue, shape);
  const wake = wakeString(provider.suspendFidelity);
  const balance = stageBalanceMc(user, props.configuration, teamBalanceMc);
  const needsCredits = stageNeedsCredits(balance, price);
  const clauses = consequenceClauses({
    configuration: props.configuration,
    price,
    needsCredits,
    billingStarted: false,
    shortfallMc: stageCreditShortfallMc(balance, price),
    ...props.context,
  });
  const offered = offeredOses(props.catalogue);
  return (
    <form
      noValidate
      className="flex min-h-0 min-w-0 flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (shape === null) return;
        props.onUseShape(shape, stagedSandboxName(form.name), wake);
      }}
    >
      <div className="-m-1 flex min-h-0 flex-col gap-4 overflow-y-auto p-1">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${ids}-name`}>Name</Label>
          <Input
            id={`${ids}-name`}
            value={form.name}
            maxLength={NAME_MAX_LENGTH}
            data-testid="sandbox-shape-sheet-name"
            onChange={(event) => setForm({ ...form, name: event.target.value })}
          />
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <ShapeSelect
            id={`${ids}-os`}
            label="Operating system"
            value={form.os}
            options={offered.map((os) => ({ value: os, label: OS_LABEL[os] }))}
            onChange={(value) => {
              const os = offered.find((candidate) => candidate === value);
              if (os === undefined) return;
              const next = stageProviderFor(props.catalogue, os);
              if (next === null) return;
              const rung = defaultShapeRung(next);
              setSizeCommitted(true);
              setForm({
                ...form,
                os,
                region: next.regions[0].id,
                growingDiskGb: "",
                ...(rung === null
                  ? { diskGb: String(next.shape.diskDefaultMb / MB_PER_GIB) }
                  : rungFields(rung)),
              });
            }}
          />
          <ShapeSelect
            id={`${ids}-region`}
            label={SANDBOX_REGION_LABEL}
            value={form.region}
            options={provider.regions.map((region) => ({
              value: region.id,
              label: region.label,
            }))}
            onChange={(value) => {
              setSizeCommitted(true);
              setForm({ ...form, region: value });
            }}
          />
          {selectableRungs === null ? (
            <>
              <ShapeNumber
                id={`${ids}-cpus`}
                label="vCPU"
                value={form.cpus}
                min={provider.shape.cpuMin}
                max={provider.shape.cpuMax}
                step={provider.shape.cpuStep}
                testId="sandbox-shape-sheet-cpus"
                onChange={(value) => {
                  setSizeCommitted(false);
                  setForm({ ...form, cpus: value });
                }}
                onCommit={() => setSizeCommitted(true)}
              />
              <ShapeNumber
                id={`${ids}-memory`}
                label="Memory (GB)"
                value={form.memoryGb}
                min={provider.shape.memoryMinMb / MB_PER_GIB}
                max={provider.shape.memoryMaxMb / MB_PER_GIB}
                step={provider.shape.memoryStepMb / MB_PER_GIB}
                testId="sandbox-shape-sheet-memory"
                onChange={(value) => {
                  setSizeCommitted(false);
                  setForm({ ...form, memoryGb: value });
                }}
                onCommit={() => setSizeCommitted(true)}
              />
              <ShapeNumber
                id={`${ids}-disk`}
                label="Disk (GB)"
                value={form.diskGb}
                min={provider.shape.diskMinMb / MB_PER_GIB}
                max={provider.shape.diskMaxMb / MB_PER_GIB}
                step={1}
                testId="sandbox-shape-sheet-disk"
                onChange={(value) => {
                  setSizeCommitted(false);
                  setForm({ ...form, diskGb: value });
                }}
                onCommit={() => setSizeCommitted(true)}
              />
            </>
          ) : (
            <>
              <div className="sm:col-span-2">
                <ShapeSelect
                  id={`${ids}-size`}
                  label="Size"
                  value={selection.value}
                  options={selectableRungs.map((rung) => ({
                    value: rungKey(rung),
                    label: rungLabel(
                      props.catalogue,
                      form,
                      rung,
                      diskGbForRung(form, provider, rung, selectedRungGrows),
                    ),
                  }))}
                  onChange={(value) => {
                    const rung = selectableRungs.find(
                      (candidate) => rungKey(candidate) === value,
                    );
                    if (rung === undefined) return;
                    setSizeCommitted(true);
                    const fields = {
                      ...rungFields(rung),
                      diskGb: diskGbForRung(
                        form,
                        provider,
                        rung,
                        selectedRungGrows,
                      ),
                    };
                    if (rung.grows === undefined) {
                      setForm({
                        ...form,
                        ...fields,
                        growingDiskGb: selectedRungGrows
                          ? form.diskGb
                          : form.growingDiskGb,
                      });
                      return;
                    }
                    setForm({ ...form, ...fields });
                  }}
                />
              </div>
              {/* A partial disk value can name a fixed rung before the edit ends. */}
              {selectedRungGrows || !sizeCommitted ? (
                <ShapeNumber
                  id={`${ids}-disk`}
                  label="Disk (GB)"
                  value={form.diskGb}
                  min={provider.shape.diskMinMb / MB_PER_GIB}
                  max={provider.shape.diskMaxMb / MB_PER_GIB}
                  step={1}
                  testId="sandbox-shape-sheet-disk"
                  onChange={(value) => {
                    setSizeCommitted(false);
                    setForm({ ...form, diskGb: value });
                  }}
                  onCommit={() => setSizeCommitted(true)}
                />
              ) : null}
            </>
          )}
        </div>
        {form.os === "windows" ? (
          <p className="m-0 text-ui-xs text-muted-foreground">
            {WINDOWS_SANDBOX_LIMITATION}
          </p>
        ) : null}
        <ShapeStartupPreview
          configuration={props.configuration}
          shape={sizeCommitted ? shape : null}
          wake={wake}
        />
        <div className="flex flex-wrap items-baseline gap-x-1.5 text-ui-xs text-muted-foreground">
          <span>
            {idleAndRestingLine(
              Number(form.idleMinutes),
              // A cleared period is never, the form's own `null`; only a form
              // that does not parse shows the shape it opened with.
              shape === null
                ? props.initialShape.destroyAfterRestingMinutes
                : shape.destroyAfterRestingMinutes,
            )}
          </span>
          <Button
            type="button"
            variant="link"
            size="inline-xs"
            aria-expanded={periodsOpen}
            onClick={() => setPeriodsOpen(!periodsOpen)}
          >
            {CHANGE_LABEL}
          </Button>
        </div>
        {periodsOpen ? (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <ShapeNumber
              id={`${ids}-idle`}
              label="Suspends after (idle minutes)"
              value={form.idleMinutes}
              min={IDLE_FLOOR_MINUTES}
              max={null}
              step={1}
              testId="sandbox-shape-sheet-idle"
              onChange={(value) => setForm({ ...form, idleMinutes: value })}
              onCommit={null}
            />
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`${ids}-resting`}>
                Destroyed after suspended or stopped for
              </Label>
              <div className="flex gap-2">
                <Input
                  id={`${ids}-resting`}
                  type="number"
                  inputMode="numeric"
                  min={1}
                  value={form.restingAmount}
                  placeholder="Never"
                  data-testid="sandbox-shape-sheet-resting"
                  onChange={(event) =>
                    setForm({ ...form, restingAmount: event.target.value })
                  }
                />
                <Select
                  value={form.restingUnit}
                  onValueChange={(value) => {
                    if (
                      value === "minutes" ||
                      value === "hours" ||
                      value === "days"
                    ) {
                      setForm({ ...form, restingUnit: value });
                    }
                  }}
                >
                  <SelectTrigger aria-label="Idle period unit">
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
          </div>
        ) : null}
        {"problem" in result ? (
          <p
            className="m-0 text-ui-sm text-destructive"
            role="alert"
            data-testid="sandbox-shape-sheet-problem"
          >
            {result.problem}
          </p>
        ) : null}
        <div
          className="flex flex-col gap-1 rounded-md border border-border/60 p-3 text-ui-xs text-muted-foreground"
          data-testid="sandbox-shape-sheet-price"
        >
          {clauses.map((clause) =>
            clause.kind === "price" ? (
              <p
                key={clause.kind}
                className="m-0 flex flex-wrap items-baseline gap-x-1.5"
              >
                <span className="text-foreground/85">{clause.text}</span>
                {needsCredits ? (
                  <AddCreditsLink
                    configuration={props.configuration}
                    testId="sandbox-shape-sheet-add-credits"
                  />
                ) : null}
              </p>
            ) : (
              <p key={clause.kind} className="m-0">
                {clause.text}
              </p>
            ),
          )}
          {price === null ? null : (
            <p className="m-0" data-testid="sandbox-shape-sheet-resting-price">
              {price.exact ? "" : "From "}Suspended:{" "}
              {shortPriceLabel(price.suspendedMcPerHour)}
              {" · "}Stopped: {shortPriceLabel(price.stoppedMcPerHour)}
            </p>
          )}
        </div>
      </div>
      <DialogFooter>
        <Button type="button" variant="ghost" onClick={props.onCancel}>
          Cancel
        </Button>
        <Button
          type="submit"
          disabled={shape === null}
          data-testid="sandbox-shape-sheet-use"
        >
          {USE_THIS_SHAPE}
        </Button>
      </DialogFooter>
    </form>
  );
}

/** The selected shape's startup time and what a later wake keeps. */
function ShapeStartupPreview(props: {
  readonly configuration: StageConfiguration;
  readonly shape: StageShape | null;
  readonly wake: string | null;
}): ReactNode {
  const readiness = useSandboxGetReadiness(props.configuration, props.shape);
  const readinessLine =
    readiness.isSuccess && !readiness.isFetching ? readiness.data : null;
  return (
    <>
      {readinessLine === null ? null : (
        <p
          className="m-0 text-ui-xs text-muted-foreground"
          data-testid="sandbox-shape-sheet-readiness"
        >
          {readinessLine}
        </p>
      )}
      {props.wake === null ? null : (
        <p className="m-0 text-ui-xs text-muted-foreground">{props.wake}</p>
      )}
    </>
  );
}

/**
 * `2 vCPU · 4 GB · 20 GB · $0.12/h`, priced in the form's region; a start
 * that grows, `2 vCPU · 4 GB, grows to 16 vCPU · 64 GB · $0.14–$1.44/h`,
 * priced at the disk selecting the option will use.
 */
function rungLabel(
  catalogue: SandboxCatalogue,
  form: ShapeForm,
  rung: SandboxShapeRung,
  diskGb: string,
): string {
  const size =
    rung.grows === undefined
      ? `${sandboxShapeLabel(rung.cpus, rung.memoryMb)} · ${formatMemory(rung.diskMb)}`
      : sandboxSizeLabel(rung.cpus, rung.memoryMb, rung.grows);
  const price = stagePrice(catalogue, {
    os: form.os,
    region: form.region,
    cpus: rung.cpus,
    memoryMb: rung.memoryMb,
    diskMb: Number(diskGb) * MB_PER_GIB,
  });
  if (price === null) return size;
  const label = shortAwakePriceLabel(price.awakeMcPerHour, price.offer);
  return `${size} · ${price.exact ? label : `from ${label}`}`;
}

function ShapeNumber(props: {
  readonly id: string;
  readonly label: string;
  readonly value: string;
  readonly min: number;
  readonly max: number | null;
  readonly step: number;
  readonly testId: string;
  readonly onChange: (value: string) => void;
  readonly onCommit: (() => void) | null;
}): ReactNode {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={props.id}>{props.label}</Label>
      <Input
        id={props.id}
        type="number"
        inputMode="decimal"
        min={props.min}
        max={props.max ?? undefined}
        step={props.step}
        value={props.value}
        data-testid={props.testId}
        onChange={(event) => props.onChange(event.target.value)}
        onBlur={props.onCommit ?? undefined}
        onKeyDown={(event) => {
          if (event.key === "Enter") props.onCommit?.();
        }}
      />
    </div>
  );
}

function ShapeSelect(props: {
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
      <Select
        value={props.value}
        onValueChange={(value) => {
          // The OS switch replaces the region and size options in the same
          // render as their values; Radix's hidden select reads the new
          // value before its option exists and reports "". Only an offered
          // value is a pick.
          if (props.options.some((option) => option.value === value)) {
            props.onChange(value);
          }
        }}
      >
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

/** Every OS some creatable provider offers, in catalogue order. */
function offeredOses(catalogue: SandboxCatalogue): readonly SandboxOs[] {
  const seen: SandboxOs[] = [];
  for (const provider of catalogue.providers) {
    if (!provider.creatable || provider.regions.length === 0) continue;
    for (const os of provider.os) {
      if (!seen.includes(os)) seen.push(os);
    }
  }
  return seen;
}
