/**
 * Docs: see ../SETTINGS.md (Environment ▸ Storage).
 * Update that file whenever this settings surface changes.
 */
import { useState, type ReactNode } from "react";
import type { z } from "zod";
import { STORAGE } from "@/components/settings/environment/storage-page.definitions";
import {
  configurationWriteIssue,
  type ConfigurationWriteIssue,
} from "@/components/settings/environment/configuration-write-issue";
import { ConfigurationWriteFeedback } from "@/components/settings/environment/configuration-write-feedback";
import { SettingsGroup } from "@/components/settings/settings-group";
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
  SNAPSHOT_POLICY_DEFAULTS,
  SNAPSHOT_POLICY_KEY,
  SNAPSHOT_POLICY_KIND,
  STORAGE_POLICY_DEFAULTS,
  STORAGE_POLICY_KEY,
  STORAGE_POLICY_KIND,
  snapshotPolicyValueSchema,
  storagePolicyValueSchema,
  useConfigurationStoragePolicy,
  type SnapshotPolicyValue,
  type StoragePolicyValue,
} from "@/hooks/environment/use-storage-policy";
import { useHostSupportsMethod } from "@/hooks/host/use-host-supports-method";
import { useReactiveHostReadiness } from "@/hooks/host/use-reactive-host-readiness";
import { trackSettingChanged, type AnalyticsSetting } from "@/lib/analytics";
import { useHostClient } from "@/lib/host";
import type { EnvironmentPick } from "@/lib/settings-environment-pages";

const APPLIES_EVERYWHERE = "Applies on every host in this environment.";
const CHAT_COMES_BACK = "A chat comes back when an agent continues it.";

type StorageField = keyof StoragePolicyValue;
/** A control on the page: a field of either item. */
type StorageControl = StorageField | keyof SnapshotPolicyValue;

const ANALYTICS_SETTING = {
  chats: "storageChats",
  idleTaskDays: "storageIdleTasks",
  archivedChatHours: "storageArchivedChats",
  quietChatDays: "storageFileEditSnapshots",
} as const satisfies Record<StorageControl, AnalyticsSetting>;

/** The select's value for a window that is not set. */
const NO_WINDOW = "none";
/** In days. */
const IDLE_TASK_PRESETS = [7, 14, 30, 90] as const;
/** In hours: 4 hours, 1, 7 and 30 days. */
const ARCHIVED_CHAT_PRESETS = [4, 24, 168, 720] as const;
/** In days, from the chat's last activity. */
const SNAPSHOT_PRESETS = [7, 30, 90] as const;

function afterDays(days: number): string {
  return days === 1 ? "After 1 day" : `After ${String(days)} days`;
}

/** Whole days when the window is at least a day and a whole number of them. */
function afterHours(hours: number): string {
  if (hours >= 24 && hours % 24 === 0) return afterDays(hours / 24);
  return hours === 1 ? "After 1 hour" : `After ${String(hours)} hours`;
}

/**
 * Environment ▸ Storage: the picked configuration's `storage_policy` item, as
 * two groups: tasks nobody has used (the chats switch and its window) and
 * archived chats (their own window), and its `snapshot_policy` item, as a
 * third: file edit snapshots (their window). Every control writes its item's
 * whole value.
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
  readonly pick: Exclude<EnvironmentPick, { readonly kind: "local" }>;
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
  readonly pick: Exclude<EnvironmentPick, { readonly kind: "local" }>;
}): ReactNode {
  const { environment, read } = useConfigurationStoragePolicy(props.pick);
  const { put } = useConfigurationItemMutations();
  // The control whose save is in flight, for its spinner.
  const [saving, setSaving] = useState<StorageControl | null>(null);
  const issue =
    put.data === undefined ? null : configurationWriteIssue(put.data);
  const policy = read.data;
  const pending = put.isPending ? put.variables : null;
  const shown = shownValue(
    storagePolicyValueSchema,
    pending?.kind === STORAGE_POLICY_KIND ? pending.value : undefined,
    policy?.storage.value,
    STORAGE_POLICY_DEFAULTS,
  );
  const shownSnapshots = shownValue(
    snapshotPolicyValueSchema,
    pending?.kind === SNAPSHOT_POLICY_KIND ? pending.value : undefined,
    policy?.snapshots.value,
    SNAPSHOT_POLICY_DEFAULTS,
  );
  const disabled =
    environment === null ||
    environment.role === null ||
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
      revision: policy.storage.revision,
    });
  };
  const writeSnapshots = (value: SnapshotPolicyValue): void => {
    if (environment === null || policy === undefined) return;
    trackSettingChanged("storage", ANALYTICS_SETTING.quietChatDays);
    setSaving("quietChatDays");
    put.mutate({
      environmentId: environment.environmentId,
      kind: SNAPSHOT_POLICY_KIND,
      key: SNAPSHOT_POLICY_KEY,
      os: null,
      value,
      revision: policy.snapshots.revision,
    });
  };
  const spinner = (field: StorageControl): ReactNode =>
    put.isPending && saving === field ? (
      <AgentSpinningDots
        className={undefined}
        testId="storage-policy-saving"
        variant={undefined}
      />
    ) : null;
  return (
    <section
      aria-label="Storage"
      className="flex flex-col gap-6"
      data-testid="storage-policy"
    >
      <SettingsGroup
        group={STORAGE.definitions.idleTasks}
        showTitle
        tone="default"
        dataTestId={undefined}
        fill={false}
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
          row={STORAGE.definitions.idleTaskWindow}
          control={
            <div className="flex items-center gap-2">
              {spinner("idleTaskDays")}
              <AgeWindowSelect
                label={windowLabel(
                  STORAGE.definitions.idleTasks.label,
                  STORAGE.definitions.idleTaskWindow.label,
                )}
                noWindowLabel="When the disk is getting full"
                noWindowLast={false}
                presets={IDLE_TASK_PRESETS}
                format={afterDays}
                value={shown.idleTaskDays}
                // The window cleans only while chats are on.
                disabled={disabled || !shown.chats}
                onWindowChange={(days) => {
                  write("idleTaskDays", days);
                }}
              />
            </div>
          }
        />
      </SettingsGroup>
      <div className="flex flex-col gap-2">
        <SettingsGroup
          group={STORAGE.definitions.archivedChats}
          showTitle
          tone="default"
          dataTestId={undefined}
          fill={false}
        >
          <SettingsRow
            row={STORAGE.definitions.archivedChatWindow}
            control={
              <div className="flex items-center gap-2">
                {spinner("archivedChatHours")}
                <AgeWindowSelect
                  label={windowLabel(
                    STORAGE.definitions.archivedChats.label,
                    STORAGE.definitions.archivedChatWindow.label,
                  )}
                  noWindowLabel="Never"
                  noWindowLast={false}
                  presets={ARCHIVED_CHAT_PRESETS}
                  format={afterHours}
                  value={shown.archivedChatHours}
                  disabled={disabled}
                  onWindowChange={(hours) => {
                    write("archivedChatHours", hours);
                  }}
                />
              </div>
            }
          />
        </SettingsGroup>
        {shown.chats ? (
          <p className="px-1 text-ui-xs text-muted-foreground">
            {CHAT_COMES_BACK}
          </p>
        ) : null}
      </div>
      <SettingsGroup
        group={STORAGE.definitions.fileEditSnapshots}
        showTitle
        tone="default"
        dataTestId={undefined}
        fill={false}
      >
        <SettingsRow
          row={STORAGE.definitions.fileEditSnapshotWindow}
          control={
            <div className="flex items-center gap-2">
              {spinner("quietChatDays")}
              <AgeWindowSelect
                label={windowLabel(
                  STORAGE.definitions.fileEditSnapshots.label,
                  STORAGE.definitions.fileEditSnapshotWindow.label,
                )}
                noWindowLabel="Never"
                noWindowLast
                presets={SNAPSHOT_PRESETS}
                format={afterDays}
                value={shownSnapshots.quietChatDays}
                disabled={disabled}
                onWindowChange={(days) => {
                  const next = snapshotPolicyValueSchema.safeParse({
                    quietChatDays: days,
                  });
                  if (next.success) writeSnapshots(next.data);
                }}
              />
            </div>
          }
        />
      </SettingsGroup>
      <StoragePolicyFooter issue={issue} />
    </section>
  );
}

/** Every window row reads "When", so a select is named with its group as well. */
function windowLabel(group: string, row: string): string {
  return `${group}: ${row}`;
}

/**
 * What an item's controls show: its save in flight while there is one, else
 * what was read, else the defaults while the read is out. A refused save drops
 * back to the value read, and the mutation's toast says why.
 */
function shownValue<V>(
  schema: z.ZodType<V>,
  pendingValue: unknown,
  readValue: V | undefined,
  defaults: V,
): V {
  if (pendingValue !== undefined) {
    const pending = schema.safeParse(pendingValue);
    if (pending.success) return pending.data;
  }
  return readValue ?? defaults;
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

/** The line under the groups, and a write's outcome. */
function StoragePolicyFooter(props: {
  readonly issue: ConfigurationWriteIssue | null;
}): ReactNode {
  return (
    <div className="flex flex-col gap-2 px-1">
      <p className="flex items-center gap-2 text-ui-xs text-muted-foreground">
        <span
          aria-hidden
          className="size-1.5 shrink-0 rounded-full bg-success"
        />
        {APPLIES_EVERYWHERE}
      </p>
      <ConfigurationWriteFeedback issue={props.issue} />
    </div>
  );
}

/**
 * An age window: no window, or one of the presets, in the unit `format`
 * reads, with no window listed first or, with `noWindowLast`, last. A stored
 * window that is not a preset is listed too, so the select shows what is in
 * force.
 */
function AgeWindowSelect(props: {
  readonly label: string;
  readonly noWindowLabel: string;
  readonly noWindowLast: boolean;
  readonly presets: readonly number[];
  readonly format: (value: number) => string;
  readonly value: number | null;
  readonly disabled: boolean;
  readonly onWindowChange: (value: number | null) => void;
}): ReactNode {
  const {
    label,
    noWindowLabel,
    noWindowLast,
    presets,
    format,
    disabled,
    onWindowChange,
  } = props;
  const current = props.value;
  const describedById = useSettingsRowDescriptionId();
  const choices =
    current === null || presets.includes(current)
      ? presets
      : [...presets, current].sort((a, b) => a - b);
  return (
    <Select
      value={current === null ? NO_WINDOW : String(current)}
      disabled={disabled}
      onValueChange={(value) => {
        const next = value === NO_WINDOW ? null : Number(value);
        if (next !== current) onWindowChange(next);
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
        {noWindowLast ? null : (
          <SelectItem value={NO_WINDOW}>{noWindowLabel}</SelectItem>
        )}
        {choices.map((choice) => (
          <SelectItem key={choice} value={String(choice)}>
            {format(choice)}
          </SelectItem>
        ))}
        {noWindowLast ? (
          <SelectItem value={NO_WINDOW}>{noWindowLabel}</SelectItem>
        ) : null}
      </SelectContent>
    </Select>
  );
}
