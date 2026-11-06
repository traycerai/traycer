/**
 * Docs: see ../SETTINGS.md (Environment ▸ Storage).
 * Update that file whenever this settings surface changes.
 */
import { useState, type ReactNode } from "react";
import { STORAGE } from "@/components/settings/environment/storage-page.definitions";
import {
  configurationWriteIssue,
  type ConfigurationWriteIssue,
} from "@/components/settings/environment/configuration-write-issue";
import { ConfigurationWriteFeedback } from "@/components/settings/environment/configuration-write-feedback";
import { SettingsRow } from "@/components/settings/settings-row";
import { useSettingsRowDescriptionId } from "@/components/settings/settings-row-description";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useCloudChatViewerId } from "@/hooks/chats/use-cloud-chat-queries";
import { useConfigurationItemMutations } from "@/hooks/environment/team/use-configuration-item-mutations";
import {
  STORAGE_POLICY_DEFAULTS,
  STORAGE_POLICY_KEY,
  STORAGE_POLICY_KIND,
  storagePolicyValueSchema,
  useConfigurationStoragePolicy,
  type StoragePolicyValue,
} from "@/hooks/environment/use-storage-policy";
import { useHostSupportsMethod } from "@/hooks/host/use-host-supports-method";
import { useReactiveHostReadiness } from "@/hooks/host/use-reactive-host-readiness";
import { trackSettingChanged, type AnalyticsSetting } from "@/lib/analytics";
import { useHostClient } from "@/lib/host";
import type { EnvironmentPick } from "@/lib/settings-environment-pages";
import { cn } from "@/lib/utils";
import { useSettingsDensity } from "@/providers/settings-density-context";

const STORAGE_FOOTNOTE =
  "Applies on every host in this environment. A chat comes back when an agent continues it.";

type StorageField = keyof StoragePolicyValue;

const ANALYTICS_SETTING = {
  chats: "storageChats",
  artifacts: "storageArtifacts",
  idleTaskDays: "storageIdleTasks",
  archivedChatDays: "storageArchivedChats",
} as const satisfies Record<StorageField, AnalyticsSetting>;

/** The select's value for a window that is not set. */
const NO_WINDOW = "none";
const IDLE_TASK_PRESETS = [7, 14, 30, 90] as const;
const ARCHIVED_CHAT_PRESETS = [7, 30, 90] as const;

function afterDays(days: number): string {
  return days === 1 ? "After 1 day" : `After ${String(days)} days`;
}

/**
 * Environment ▸ Storage: the picked configuration's `storage_policy` item,
 * as two switches (chats, artifacts) and two age windows (idle tasks,
 * archived chats). Every control writes the whole value.
 *
 * Rendered only when the surface's host advertises the item write
 * (`environment.configuration.items.put`, answered by the pool in a pool
 * build): an older host draws nothing. The host is the one the write is sent
 * through (`useConfigurationItemMutations`). Keyed by the viewer, as the
 * auto-archive row is: the save in flight and its outcome belong to the
 * person using the page, so an account switch with Settings open starts the
 * page over instead of showing the outgoing account's save.
 */
export function StoragePolicySection(props: {
  readonly pick: EnvironmentPick;
}): ReactNode {
  const writeSupported = useHostSupportsMethod(
    useReactiveHostReadiness(useHostClient()).hostId,
    "environment.configuration.items.put",
  );
  const viewerUserId = useCloudChatViewerId();
  if (!writeSupported) return null;
  return <StoragePolicySectionBody key={viewerUserId} pick={props.pick} />;
}

function StoragePolicySectionBody(props: {
  readonly pick: EnvironmentPick;
}): ReactNode {
  const { environment, read } = useConfigurationStoragePolicy(props.pick);
  const { put } = useConfigurationItemMutations();
  // The control whose save is in flight, for its spinner.
  const [saving, setSaving] = useState<StorageField | null>(null);
  const issue =
    put.data === undefined ? null : configurationWriteIssue(put.data);
  const policy = read.data;
  const shown = shownPolicy(
    put.isPending ? put.variables.value : undefined,
    policy?.value,
  );
  const disabled =
    environment === null ||
    environment.role === "viewer" ||
    policy === undefined ||
    put.isPending;
  const write = <F extends StorageField>(
    field: F,
    value: StoragePolicyValue[F],
  ): void => {
    if (environment === null || policy === undefined) return;
    trackSettingChanged("storage", ANALYTICS_SETTING[field]);
    setSaving(field);
    put.mutate({
      environmentId: environment.environmentId,
      kind: STORAGE_POLICY_KIND,
      key: STORAGE_POLICY_KEY,
      os: null,
      value: { ...shown, [field]: value },
      revision: policy.revision,
    });
  };
  const spinner = (field: StorageField): ReactNode =>
    put.isPending && saving === field ? (
      <AgentSpinningDots
        className={undefined}
        testId="storage-policy-saving"
        variant={undefined}
      />
    ) : null;
  const active = shown.chats || shown.artifacts;
  return (
    <section
      aria-label="Storage"
      className="flex flex-col border-b border-border/60"
      data-testid="storage-policy"
    >
      <SettingsRow
        row={STORAGE.definitions.chats}
        status={
          read.isError ? (
            <ReadErrorStatus
              onRetry={() => {
                void read.refetch();
              }}
            />
          ) : undefined
        }
        control={
          <div className="flex items-center gap-2">
            {spinner("chats")}
            <Switch
              checked={shown.chats}
              disabled={disabled}
              aria-label={STORAGE.definitions.chats.label}
              onCheckedChange={(chats) => {
                write("chats", chats);
              }}
            />
          </div>
        }
      />
      <SettingsRow
        row={STORAGE.definitions.artifacts}
        control={
          <div className="flex items-center gap-2">
            {spinner("artifacts")}
            <Switch
              checked={shown.artifacts}
              disabled={disabled}
              aria-label={STORAGE.definitions.artifacts.label}
              onCheckedChange={(artifacts) => {
                write("artifacts", artifacts);
              }}
            />
          </div>
        }
      />
      <SettingsRow
        row={STORAGE.definitions.idleTasks}
        control={
          <div className="flex items-center gap-2">
            {spinner("idleTaskDays")}
            <AgeWindowSelect
              label={STORAGE.definitions.idleTasks.label}
              noWindowLabel="When the disk is getting full"
              presets={IDLE_TASK_PRESETS}
              days={shown.idleTaskDays}
              // The window cleans whichever kinds are on.
              disabled={disabled || !active}
              onDaysChange={(days) => {
                write("idleTaskDays", days);
              }}
            />
          </div>
        }
      />
      <SettingsRow
        row={STORAGE.definitions.archivedChats}
        control={
          <div className="flex items-center gap-2">
            {spinner("archivedChatDays")}
            <AgeWindowSelect
              label={STORAGE.definitions.archivedChats.label}
              noWindowLabel="Never"
              presets={ARCHIVED_CHAT_PRESETS}
              days={shown.archivedChatDays}
              disabled={disabled || !shown.chats}
              onDaysChange={(days) => {
                write("archivedChatDays", days);
              }}
            />
          </div>
        }
      />
      <StoragePolicyFooter active={active} issue={issue} />
    </section>
  );
}

/**
 * What the page shows: the save in flight while there is one, else what was
 * read, else the defaults while the read is out. A refused save drops back to
 * the value read, and the mutation's toast says why.
 */
function shownPolicy(
  pendingValue: unknown,
  readValue: StoragePolicyValue | undefined,
): StoragePolicyValue {
  if (pendingValue !== undefined) {
    const pending = storagePolicyValueSchema.safeParse(pendingValue);
    if (pending.success) return pending.data;
  }
  return readValue ?? STORAGE_POLICY_DEFAULTS;
}

/** The Chats row's description when the read failed, with a retry. */
function ReadErrorStatus(props: { readonly onRetry: () => void }): ReactNode {
  return (
    <div className="flex flex-col gap-1">
      <p>{STORAGE.definitions.chats.description}</p>
      <div className="flex flex-wrap items-center gap-2">
        <p role="status">Couldn&apos;t read this setting.</p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={props.onRetry}
        >
          Retry
        </Button>
      </div>
    </div>
  );
}

/** The line under the rows while either kind is on, and a write's outcome. */
function StoragePolicyFooter(props: {
  readonly active: boolean;
  readonly issue: ConfigurationWriteIssue | null;
}): ReactNode {
  const compact = useSettingsDensity() === "compact";
  if (!props.active && props.issue === null) return null;
  return (
    <div
      className={cn(
        "flex flex-col gap-2",
        compact ? "px-4 py-2.5" : "px-5 py-4",
      )}
    >
      {props.active ? (
        <p className="flex items-center gap-2 text-ui-xs text-muted-foreground">
          <span
            aria-hidden
            className="size-1.5 shrink-0 rounded-full bg-success"
          />
          {STORAGE_FOOTNOTE}
        </p>
      ) : null}
      <ConfigurationWriteFeedback issue={props.issue} />
    </div>
  );
}

/**
 * An age window: no window, or one of the presets. A stored window that is
 * not a preset is listed too, so the select shows what is in force.
 */
function AgeWindowSelect(props: {
  readonly label: string;
  readonly noWindowLabel: string;
  readonly presets: readonly number[];
  readonly days: number | null;
  readonly disabled: boolean;
  readonly onDaysChange: (days: number | null) => void;
}): ReactNode {
  const { label, noWindowLabel, presets, days, disabled, onDaysChange } = props;
  const describedById = useSettingsRowDescriptionId();
  const choices =
    days === null || presets.includes(days)
      ? presets
      : [...presets, days].sort((a, b) => a - b);
  return (
    <Select
      value={days === null ? NO_WINDOW : String(days)}
      disabled={disabled}
      onValueChange={(value) => {
        const next = value === NO_WINDOW ? null : Number(value);
        if (next !== days) onDaysChange(next);
      }}
    >
      <SelectTrigger
        aria-label={label}
        aria-describedby={describedById}
        className="w-[min(60vw,16rem)]"
        size="sm"
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={NO_WINDOW}>{noWindowLabel}</SelectItem>
        {choices.map((choice) => (
          <SelectItem key={choice} value={String(choice)}>
            {afterDays(choice)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
