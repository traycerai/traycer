/**
 * Docs: see ../../SETTINGS.md (Permissions ▸ Judge).
 * Update that file whenever this settings surface changes.
 */
import { useId, useRef, useState, type ReactNode } from "react";
import { ChevronsUpDown } from "lucide-react";
import type { GuiHarnessOption } from "@traycer/protocol/host/index";
import type {
  AgentReasoningEffortOption,
  GuiAgentModelOption,
} from "@traycer/protocol/host/agent/gui/unary-schemas";
import type {
  ProviderCliState,
  ProviderProfile,
} from "@traycer/protocol/host/provider-schemas";
import type { AutoJudgeSelection } from "@traycer/protocol/host/auto-mode/contracts";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useCoarsePointerOpenAutoFocus } from "@/hooks/ui/use-coarse-pointer-open-autofocus";
import {
  profileCommitId,
  profileDisplayLabel,
} from "@/components/providers/provider-profile-model";
import { modelDisplayLabel } from "@/components/home/data/landing-options";
import {
  judgeModelsFailedLine,
  judgeNoModelsLine,
  judgeProfileBlocker,
  judgeProviderBlocker,
} from "@/components/settings/panels/auto-judge-selection";
import { autoJudgeModelLabel } from "@/hooks/auto-mode/use-auto-judge-billing";
import { cn } from "@/lib/utils";

/**
 * The three controls behind "A specific model": Provider, Account and Model.
 *
 * Each commits its own field and each closes after its own choice, which is
 * what a Select does - so choosing a provider never closes, empties or
 * disables the Model control, and nothing here is disabled while a write is in
 * flight. The owner holds the value the controls present until the write
 * settles, and rolls it back to the stored record on a refusal.
 */
export function JudgeModelField(props: {
  readonly harnesses: ReadonlyArray<GuiHarnessOption> | undefined;
  /** The chosen provider's `providers.list` row, or `undefined` when unknown. */
  readonly provider: ProviderCliState | undefined;
  /** What the controls present: the in-flight pick, else the stored record. */
  readonly selection: AutoJudgeSelection | null;
  /** The chosen provider's catalog, `undefined` while it has not answered. */
  readonly models: ReadonlyArray<GuiAgentModelOption> | undefined;
  /** The chosen provider's catalog read failed, so `models` is not coming. */
  readonly modelsFailed: boolean;
  /**
   * The chosen model's own advertised efforts, in canonical low-to-high order
   * (its first entry is the lowest, whatever order the harness's own catalog
   * lists them in). Empty while the model is unknown or advertises none.
   */
  readonly effortOptions: ReadonlyArray<AgentReasoningEffortOption>;
  /** `null` is the host's default for the model - its lowest effort. */
  readonly effort: string | null;
  /** Whether the host's negotiated `autoJudge.set` can even store an effort. */
  readonly showEffort: boolean;
  /**
   * The chosen provider when it cannot run here and nothing else on the tab
   * already links to its fix; `null` otherwise.
   */
  readonly openProvidersFor: GuiHarnessOption | null;
  readonly disabled: boolean;
  readonly onProvider: (row: GuiHarnessOption) => void;
  readonly onAccount: (profileId: string | null) => void;
  readonly onModel: (slug: string) => void;
  readonly onEffort: (effort: string | null) => void;
  readonly onOpenProvider: (row: GuiHarnessOption) => void;
}): ReactNode {
  const { selection } = props;
  const profiles = props.provider?.profiles ?? [];
  const showAccount = selection !== null && profiles.length > 1;
  const showEffort = props.showEffort && props.effortOptions.length > 0;
  const fieldCount = 2 + (showAccount ? 1 : 0) + (showEffort ? 1 : 0);
  return (
    <div
      className={cn("grid grid-cols-1 gap-3", fieldColumnsClass(fieldCount))}
      data-testid="judge-model-field"
    >
      <ProviderField
        harnesses={props.harnesses}
        value={selection?.harnessId ?? null}
        disabled={props.disabled}
        openProvidersFor={props.openProvidersFor}
        onProvider={props.onProvider}
        onOpenProvider={props.onOpenProvider}
      />
      {showAccount ? (
        <AccountField
          profiles={profiles}
          value={selection.profileId}
          disabled={props.disabled}
          onAccount={props.onAccount}
        />
      ) : null}
      <ModelField
        models={props.models}
        modelsFailed={props.modelsFailed}
        providerLabel={selectedProviderLabel(props.harnesses, selection)}
        value={selection?.model ?? null}
        disabled={props.disabled || selection === null}
        onModel={props.onModel}
      />
      {showEffort ? (
        <EffortField
          effortOptions={props.effortOptions}
          effort={props.effort}
          disabled={props.disabled || selection === null}
          onEffort={props.onEffort}
        />
      ) : null}
    </div>
  );
}

/** A provider as the fields name it: its catalog label, else its id. */
function judgeProviderLabel(
  harnesses: ReadonlyArray<GuiHarnessOption> | undefined,
  harnessId: string,
): string {
  return harnesses?.find((row) => row.id === harnessId)?.label ?? harnessId;
}

function FieldLabel(props: {
  readonly id: string;
  readonly children: ReactNode;
}): ReactNode {
  return (
    <span id={props.id} className="text-ui-xs text-muted-foreground">
      {props.children}
    </span>
  );
}

/**
 * Every catalog row, because every adapter can judge. A row that cannot run
 * today is a disabled option naming why. The fix lives in the provider's own
 * settings, and one "Open Providers" link under the field reaches it while the
 * CHOSEN provider is the blocked one - never a control inside the list, whose
 * options are the only thing a listbox may hold.
 */
function ProviderField(props: {
  readonly harnesses: ReadonlyArray<GuiHarnessOption> | undefined;
  readonly value: string | null;
  readonly disabled: boolean;
  readonly openProvidersFor: GuiHarnessOption | null;
  readonly onProvider: (row: GuiHarnessOption) => void;
  readonly onOpenProvider: (row: GuiHarnessOption) => void;
}): ReactNode {
  const labelId = useId();
  const harnesses = props.harnesses ?? [];
  const { openProvidersFor } = props;
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <FieldLabel id={labelId}>Provider</FieldLabel>
      <Select
        value={props.value ?? ""}
        disabled={props.disabled || props.harnesses === undefined}
        onValueChange={(next) => {
          const row = harnesses.find((candidate) => candidate.id === next);
          if (row !== undefined) props.onProvider(row);
        }}
      >
        <SelectTrigger
          aria-labelledby={labelId}
          className="w-full min-w-0"
          data-testid="judge-provider-select"
        >
          <SelectValue placeholder="Choose a provider" />
        </SelectTrigger>
        <SelectContent>
          {harnesses.map((row) => (
            <ProviderOption key={row.id} row={row} />
          ))}
        </SelectContent>
      </Select>
      {openProvidersFor === null ? null : (
        <Button
          type="button"
          variant="link"
          size="inline-xs"
          className="self-start"
          data-testid="judge-open-providers"
          onClick={() => props.onOpenProvider(openProvidersFor)}
        >
          Open Providers
        </Button>
      )}
    </div>
  );
}

function ProviderOption(props: { readonly row: GuiHarnessOption }): ReactNode {
  const { row } = props;
  const blocker = judgeProviderBlocker(row);
  if (blocker === null) {
    return <SelectItem value={row.id}>{row.label}</SelectItem>;
  }
  return (
    <SelectItem
      value={row.id}
      disabled
      data-testid={`judge-provider-blocked-${row.id}`}
    >
      <span className="flex min-w-0 flex-col">
        <span className="truncate">{row.label}</span>
        <span className="text-ui-xs text-muted-foreground">{blocker}</span>
      </span>
    </SelectItem>
  );
}

/**
 * The provider's accounts, shown only when it has more than one. Values are
 * the wire `profileId`s a Select needs; what commits is the COMMIT id, where
 * the ambient login is `null`.
 */
function AccountField(props: {
  readonly profiles: ReadonlyArray<ProviderProfile>;
  readonly value: string | null;
  readonly disabled: boolean;
  readonly onAccount: (profileId: string | null) => void;
}): ReactNode {
  const labelId = useId();
  const selected = props.profiles.find(
    (profile) => profileCommitId(profile) === props.value,
  );
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <FieldLabel id={labelId}>Account</FieldLabel>
      <Select
        value={selected?.profileId ?? ""}
        disabled={props.disabled}
        onValueChange={(next) => {
          const profile = props.profiles.find(
            (candidate) => candidate.profileId === next,
          );
          if (profile !== undefined) props.onAccount(profileCommitId(profile));
        }}
      >
        <SelectTrigger
          aria-labelledby={labelId}
          className="w-full min-w-0"
          data-testid="judge-account-select"
        >
          <SelectValue placeholder="Choose an account" />
        </SelectTrigger>
        <SelectContent>
          {props.profiles.map((profile) => {
            const blocker = judgeProfileBlocker(profile);
            return (
              <SelectItem
                key={profile.profileId}
                value={profile.profileId}
                disabled={blocker !== null}
              >
                {blocker === null
                  ? profileDisplayLabel(profile)
                  : `${profileDisplayLabel(profile)} · ${blocker}`}
              </SelectItem>
            );
          })}
        </SelectContent>
      </Select>
    </div>
  );
}

/**
 * A searchable list, because some catalogs (OpenRouter's) run to hundreds of
 * models. Portaled into the Settings dialog when it is one, so the dialog's
 * scroll lock and focus trap still hold, as the font picker does.
 */
function ModelField(props: {
  readonly models: ReadonlyArray<GuiAgentModelOption> | undefined;
  readonly modelsFailed: boolean;
  readonly providerLabel: string;
  readonly value: string | null;
  readonly disabled: boolean;
  readonly onModel: (slug: string) => void;
}): ReactNode {
  const labelId = useId();
  const popoverId = useId();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [dialogContainer, setDialogContainer] = useState<HTMLElement | null>(
    null,
  );
  const { contentRef, onOpenAutoFocus } = useCoarsePointerOpenAutoFocus();
  const models = props.models ?? [];
  const needle = query.trim().toLowerCase();
  const filtered =
    needle.length === 0
      ? models
      : models.filter(
          (model) =>
            model.label.toLowerCase().includes(needle) ||
            model.slug.toLowerCase().includes(needle),
        );
  const valueLabel =
    props.value === null || props.value.length === 0
      ? null
      : (autoJudgeModelLabel(props.models, props.value) ?? props.value);
  const emptyLine = modelListEmptyLine({
    models: props.models,
    modelsFailed: props.modelsFailed,
    providerLabel: props.providerLabel,
    matching: filtered.length,
  });
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <FieldLabel id={labelId}>Model</FieldLabel>
      <Popover
        open={open}
        onOpenChange={(next) => {
          if (next) {
            setDialogContainer(
              triggerRef.current?.closest<HTMLElement>(
                '[data-slot="dialog-content"]',
              ) ?? null,
            );
          } else {
            setQuery("");
          }
          setOpen(next);
        }}
      >
        <PopoverTrigger asChild>
          <Button
            ref={triggerRef}
            type="button"
            variant="outline"
            size="sm"
            role="combobox"
            aria-expanded={open}
            aria-controls={popoverId}
            aria-labelledby={labelId}
            disabled={props.disabled}
            className="w-full min-w-0 justify-between"
            data-testid="judge-model-combobox"
          >
            <span
              className={cn(
                "min-w-0 truncate",
                valueLabel === null && "text-muted-foreground",
              )}
            >
              {valueLabel ?? "Choose a model"}
            </span>
            <ChevronsUpDown className="size-4 shrink-0 text-muted-foreground" />
          </Button>
        </PopoverTrigger>
        <PopoverContent
          id={popoverId}
          layout="bare"
          align="start"
          container={dialogContainer ?? undefined}
          collisionBoundary={dialogContainer ?? undefined}
          collisionPadding={8}
          className="w-[min(85vw,20rem)] overflow-hidden"
          ref={contentRef}
          onOpenAutoFocus={onOpenAutoFocus}
        >
          <Command shouldFilter={false}>
            <CommandInput
              aria-label="Search models"
              value={query}
              onValueChange={setQuery}
              placeholder="Search models…"
              spellCheck={false}
            />
            <CommandList className="max-h-[min(50vh,18rem)] p-1">
              {emptyLine === null ? null : (
                <CommandEmpty>{emptyLine}</CommandEmpty>
              )}
              {filtered.length > 0 ? (
                <CommandGroup>
                  {filtered.map((model) => (
                    <CommandItem
                      key={model.slug}
                      value={model.slug}
                      data-checked={
                        model.slug === props.value ? "true" : "false"
                      }
                      onSelect={() => {
                        setOpen(false);
                        setQuery("");
                        props.onModel(model.slug);
                      }}
                    >
                      <span className="min-w-0 flex-1 break-words">
                        {modelDisplayLabel(model)}
                      </span>
                    </CommandItem>
                  ))}
                </CommandGroup>
              ) : null}
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
    </div>
  );
}

/** One column per field from `sm` up; the fields stack below it. */
function fieldColumnsClass(fieldCount: number): string {
  if (fieldCount === 4) return "sm:grid-cols-4";
  if (fieldCount === 3) return "sm:grid-cols-3";
  return "sm:grid-cols-2";
}

/** The chosen provider's label for the Model field's copy; `""` with none. */
function selectedProviderLabel(
  harnesses: ReadonlyArray<GuiHarnessOption> | undefined,
  selection: AutoJudgeSelection | null,
): string {
  return selection === null
    ? ""
    : judgeProviderLabel(harnesses, selection.harnessId);
}

/**
 * The `Select`'s stand-in for `null` - the host's default effort for the
 * chosen model, its lowest advertised one. A sentinel rather than `""`
 * because Radix reads an empty string as "nothing selected" and would show
 * the placeholder for a choice the user made; it never reaches the wire, and
 * it cannot collide with a real effort id, which is a provider's own
 * vocabulary.
 */
const DEFAULT_EFFORT_VALUE = "__judge-default-effort__";

/**
 * The reasoning effort the judge model runs at, alongside Provider/Account/
 * Model. Rendered only by the caller, and only once the chosen model
 * advertises at least one effort - a model with none has nothing to pick
 * from and no "default" to name either.
 *
 * The first option is always the host's default, labelled with the actual
 * lowest effort's own label (`Default (Low)`) rather than a generic word, so
 * choosing "the default" and choosing that level explicitly read as the same
 * thing they resolve to.
 */
function EffortField(props: {
  readonly effortOptions: ReadonlyArray<AgentReasoningEffortOption>;
  readonly effort: string | null;
  readonly disabled: boolean;
  readonly onEffort: (effort: string | null) => void;
}): ReactNode {
  const labelId = useId();
  const { effortOptions } = props;
  const lowestLabel = effortOptions.at(0)?.label;
  const defaultLabel =
    lowestLabel === undefined ? "Default (lowest)" : `Default (${lowestLabel})`;
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <FieldLabel id={labelId}>Effort</FieldLabel>
      <Select
        value={props.effort ?? DEFAULT_EFFORT_VALUE}
        disabled={props.disabled}
        onValueChange={(next) => {
          props.onEffort(next === DEFAULT_EFFORT_VALUE ? null : next);
        }}
      >
        <SelectTrigger
          aria-labelledby={labelId}
          className="w-full min-w-0"
          data-testid="judge-effort-select"
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={DEFAULT_EFFORT_VALUE}>{defaultLabel}</SelectItem>
          {effortOptions.map((option) => (
            <SelectItem key={option.id} value={option.id}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

/**
 * What the model list says when it lists nothing: still loading, a failed
 * read, a provider with no models at all, or a search that matched none.
 * Loading is only ever claimed while a read is still pending.
 */
function modelListEmptyLine(input: {
  readonly models: ReadonlyArray<GuiAgentModelOption> | undefined;
  readonly modelsFailed: boolean;
  readonly providerLabel: string;
  readonly matching: number;
}): string | null {
  if (input.models === undefined) {
    return input.modelsFailed
      ? judgeModelsFailedLine(input.providerLabel)
      : "Loading models…";
  }
  if (input.models.length === 0) return judgeNoModelsLine(input.providerLabel);
  return input.matching === 0 ? "No matching models." : null;
}
