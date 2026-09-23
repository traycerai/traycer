/**
 * Docs: see ../../SETTINGS.md (Permissions ▸ Judge).
 * Update that file whenever this settings surface changes.
 */
import { useId, useRef, useState, type ReactNode } from "react";
import { ChevronsUpDown } from "lucide-react";
import type { GuiHarnessOption } from "@traycer/protocol/host/index";
import type { GuiAgentModelOption } from "@traycer/protocol/host/agent/gui/unary-schemas";
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
import {
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
  readonly disabled: boolean;
  readonly onProvider: (row: GuiHarnessOption) => void;
  readonly onAccount: (profileId: string | null) => void;
  readonly onModel: (slug: string) => void;
  readonly onOpenProvider: (row: GuiHarnessOption) => void;
}): ReactNode {
  const profiles = props.provider?.profiles ?? [];
  const showAccount = props.selection !== null && profiles.length > 1;
  return (
    <div
      className={cn(
        "grid grid-cols-1 gap-3",
        showAccount ? "sm:grid-cols-3" : "sm:grid-cols-2",
      )}
      data-testid="judge-model-field"
    >
      <ProviderField
        harnesses={props.harnesses}
        value={props.selection?.harnessId ?? null}
        disabled={props.disabled}
        onProvider={props.onProvider}
        onOpenProvider={props.onOpenProvider}
      />
      {showAccount ? (
        <AccountField
          profiles={profiles}
          value={props.selection.profileId}
          disabled={props.disabled}
          onAccount={props.onAccount}
        />
      ) : null}
      <ModelField
        models={props.models}
        value={props.selection?.model ?? null}
        disabled={props.disabled || props.selection === null}
        onModel={props.onModel}
      />
    </div>
  );
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
 * today is a disabled option naming why, with a link beside it to the
 * provider's own settings, where the fix is.
 */
function ProviderField(props: {
  readonly harnesses: ReadonlyArray<GuiHarnessOption> | undefined;
  readonly value: string | null;
  readonly disabled: boolean;
  readonly onProvider: (row: GuiHarnessOption) => void;
  readonly onOpenProvider: (row: GuiHarnessOption) => void;
}): ReactNode {
  const labelId = useId();
  const harnesses = props.harnesses ?? [];
  const [open, setOpen] = useState(false);
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <FieldLabel id={labelId}>Provider</FieldLabel>
      <Select
        open={open}
        onOpenChange={setOpen}
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
          {harnesses.map((row) => {
            const blocker = judgeProviderBlocker(row);
            if (blocker === null) {
              return (
                <SelectItem key={row.id} value={row.id}>
                  {row.label}
                </SelectItem>
              );
            }
            return (
              <div
                key={row.id}
                className="flex min-w-0 items-center gap-2 pr-2"
                data-testid={`judge-provider-blocked-${row.id}`}
              >
                <SelectItem value={row.id} disabled className="flex-1">
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate">{row.label}</span>
                    <span className="text-ui-xs text-muted-foreground">
                      {blocker}
                    </span>
                  </span>
                </SelectItem>
                <Button
                  type="button"
                  variant="link"
                  size="inline-xs"
                  onClick={() => {
                    setOpen(false);
                    props.onOpenProvider(row);
                  }}
                >
                  Open Providers
                </Button>
              </div>
            );
          })}
        </SelectContent>
      </Select>
    </div>
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
              {props.models === undefined ? (
                <CommandEmpty>Loading models…</CommandEmpty>
              ) : null}
              {props.models !== undefined && filtered.length === 0 ? (
                <CommandEmpty>No matching models.</CommandEmpty>
              ) : null}
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
                        {autoJudgeModelLabel(props.models, model.slug) ??
                          model.label}
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
