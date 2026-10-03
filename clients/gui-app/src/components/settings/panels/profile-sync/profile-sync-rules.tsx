import { useId, useState, type ReactNode } from "react";
import type { ProviderCliState } from "@traycer/protocol/host/provider-schemas";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import {
  PROFILE_SYNC_MAX_RULES,
  type ProfileSyncBatch,
  type ProfileSyncList,
  type ProfileSyncRule,
  type ProfileSyncSaveRule,
  type ProfileSyncScope,
} from "@traycer/protocol/host/profile-sync-schemas";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { MutedAgentSpinner } from "@/components/ui/agent-spinning-dots";
import {
  useProfileSyncSaveRule,
  useProfileSyncStopRule,
} from "@/hooks/providers/use-profile-sync";
import {
  PROFILE_COPY_PROVIDERS,
  profileCopyWireProvider,
  type ProfileCopyWireProvider,
} from "@/lib/profile-copy/profile-copy-model";
import {
  profileCopyProviderLabel,
  profileCopyRequestErrorText,
  type ProfileCopyHosts,
} from "../profile-copy/profile-copy-shared";
import { ProfileSyncProviderPicker } from "./profile-sync-provider-picker";
import { useProfileCopyFlowStore } from "@/stores/settings/profile-copy-flow-store";

const RULE_CAPACITY_NOTICE = `Automatic sync supports up to ${String(PROFILE_SYNC_MAX_RULES)} device rules. Stop a rule to add another device.`;

export function ProfileSyncRules(props: {
  readonly hostId: string;
  readonly hosts: ProfileCopyHosts;
  readonly providers: readonly ProviderCliState[];
  readonly rules: readonly ProfileSyncRule[];
  readonly batches: readonly ProfileSyncBatch[];
  readonly onViewRun: (batchId: string) => void;
  readonly onSaved: (rule: ProfileSyncRule) => void;
  readonly onStopped: (list: ProfileSyncList) => void;
}): ReactNode {
  const [editor, setEditor] = useState<string | null>(null);
  const [stop, setStop] = useState<ProfileSyncRule | null>(null);
  const save = useProfileSyncSaveRule(props.hostId),
    remove = useProfileSyncStopRule(props.hostId);
  const pending = save.isPending || remove.isPending;
  const saveError = ruleActionError(props.rules, save.variables, save.error);
  const removeError = ruleActionError(
    props.rules,
    remove.variables,
    remove.error,
  );
  const atCapacity = props.rules.length >= PROFILE_SYNC_MAX_RULES;
  const destinations = props.hosts.options.filter(
    (h) =>
      h.hostId !== props.hostId &&
      !props.rules.some((r) => r.destinationHostId === h.hostId),
  );
  if (props.rules.some((rule) => rule.sourceHostId !== props.hostId))
    return (
      <p role="alert" className="text-ui-xs text-destructive">
        The device returned rules for another source. Check sync history again.
      </p>
    );
  if (editor !== null)
    return (
      <ProfileSyncRuleEditView
        key={editor}
        editor={editor}
        rules={props.rules}
        hostId={props.hostId}
        hosts={props.hosts}
        candidates={atCapacity ? [] : destinations.map((h) => h.hostId)}
        atCapacity={atCapacity}
        providers={props.providers}
        close={() => setEditor(null)}
        onSaved={props.onSaved}
      />
    );
  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-ui-sm font-medium">Keep profiles in sync</h3>
          <p className="text-ui-xs text-muted-foreground">
            One-way rules from {props.hosts.nameFor(props.hostId)}.
          </p>
        </div>
        <Button
          size="sm"
          variant="outline"
          disabled={pending || destinations.length === 0 || atCapacity}
          onClick={() => setEditor("new")}
        >
          Add device
        </Button>
      </div>
      <ProfileSyncRuleCapacity reached={atCapacity} />
      {props.rules.length === 0 ? (
        <p className="py-5 text-ui-sm text-muted-foreground">
          No automatic rules yet. Add a device and choose which providers to
          keep in sync.
        </p>
      ) : (
        props.rules.map((rule) => (
          <article
            key={rule.ruleId}
            className="flex flex-col gap-2 rounded-lg border border-border/60 p-3"
          >
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-ui-sm font-medium">
                {props.hosts.nameFor(rule.destinationHostId)}
              </h3>
              <span className="text-ui-xs text-muted-foreground">
                {ruleStatus(rule)}
              </span>
            </div>
            <p className="text-ui-xs text-muted-foreground">
              {rule.scope.kind === "all"
                ? "All supported providers, including future providers"
                : `${rule.scope.providers.map(profileCopyProviderLabel).join(", ")} · includes future profiles`}
            </p>
            <p className="text-ui-xs text-muted-foreground">
              {rule.lastCheckedAt === null
                ? "First sync pending"
                : `Last checked ${new Date(rule.lastCheckedAt).toLocaleString()}`}
            </p>
            <div className="flex flex-wrap gap-1">
              <Button
                size="xs"
                variant="outline"
                disabled={pending}
                onClick={() => setEditor(rule.ruleId)}
              >
                Edit
              </Button>
              <Button
                size="xs"
                variant="outline"
                disabled={pending}
                onClick={() =>
                  save.mutate(
                    {
                      ruleId: rule.ruleId,
                      sourceHostId: props.hostId,
                      destinationHostId: rule.destinationHostId,
                      scope: rule.scope,
                      paused: !rulePaused(rule),
                      expectedRevision: rule.revision,
                    },
                    { onSuccess: props.onSaved },
                  )
                }
              >
                {save.isPending && save.variables.ruleId === rule.ruleId ? (
                  <MutedAgentSpinner />
                ) : null}
                {rulePaused(rule) ? "Resume" : "Pause"}
              </Button>
              {canViewRuleRun(rule, props.batches, props.hostId) ? (
                <Button
                  size="xs"
                  variant="ghost"
                  disabled={pending}
                  onClick={() => {
                    if (rule.batchId !== null) props.onViewRun(rule.batchId);
                  }}
                >
                  View results
                </Button>
              ) : null}
              <Button
                size="xs"
                variant="ghost"
                disabled={pending}
                onClick={() => setStop(rule)}
              >
                Stop…
              </Button>
            </div>
            {stop?.ruleId === rule.ruleId ? (
              <div className="flex flex-col gap-2 rounded-md bg-foreground/5 p-3">
                <p className="text-ui-xs">
                  Stop future updates? Profiles already on this device will
                  remain.
                </p>
                {stop.revision !== rule.revision ? (
                  <p role="alert" className="text-ui-xs text-muted-foreground">
                    This rule changed. Choose Keep rule, review its current
                    settings, then choose Stop again.
                  </p>
                ) : null}
                <div className="flex gap-2">
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={pending}
                    onClick={() => setStop(null)}
                  >
                    Keep rule
                  </Button>
                  <Button
                    size="xs"
                    disabled={pending || stop.revision !== rule.revision}
                    onClick={() => {
                      if (pending || stop.revision !== rule.revision) return;
                      remove.mutate(
                        {
                          sourceHostId: props.hostId,
                          ruleId: stop.ruleId,
                          expectedRevision: stop.revision,
                        },
                        {
                          onSuccess: (list) => {
                            props.onStopped(list);
                            setStop(null);
                          },
                        },
                      );
                    }}
                  >
                    {remove.isPending ? <MutedAgentSpinner /> : null}Stop
                    automatic sync
                  </Button>
                </div>
              </div>
            ) : null}
          </article>
        ))
      )}
      {saveError !== null ? (
        <p role="alert" className="text-ui-xs text-destructive">
          {profileCopyRequestErrorText(
            saveError,
            props.hosts.nameFor(props.hostId),
          )}
        </p>
      ) : null}
      {removeError !== null ? (
        <p role="alert" className="text-ui-xs text-destructive">
          {profileCopyRequestErrorText(
            removeError,
            props.hosts.nameFor(props.hostId),
          )}
        </p>
      ) : null}
      <p className="text-ui-xs text-muted-foreground">
        Destination edits need review. Pausing or stopping a rule keeps the
        profiles on that device.
      </p>
    </section>
  );
}
type RuleActionRequest = Pick<
  ProfileSyncSaveRule,
  "ruleId" | "expectedRevision"
>;
function ruleActionError(
  rules: readonly ProfileSyncRule[],
  request: RuleActionRequest | undefined,
  error: HostRpcError | null,
): HostRpcError | null {
  if (request === undefined) return null;
  return rules.some(
    (rule) =>
      rule.ruleId === request.ruleId &&
      rule.revision <= request.expectedRevision,
  )
    ? error
    : null;
}

function ProfileSyncRuleEditView(props: {
  readonly editor: string;
  readonly rules: readonly ProfileSyncRule[];
  readonly hostId: string;
  readonly hosts: ProfileCopyHosts;
  readonly candidates: readonly string[];
  readonly atCapacity: boolean;
  readonly providers: readonly ProviderCliState[];
  readonly close: () => void;
  readonly onSaved: (rule: ProfileSyncRule) => void;
}): ReactNode {
  const rule = props.rules.find((rule) => rule.ruleId === props.editor) ?? null;
  return (
    <ProfileSyncRuleEditor
      hostId={props.hostId}
      existingRuleId={props.editor === "new" ? null : props.editor}
      rule={rule}
      hosts={props.hosts}
      candidates={props.candidates}
      atCapacity={props.atCapacity}
      providers={props.providers}
      close={props.close}
      onSaved={props.onSaved}
    />
  );
}

interface RuleEditorProps {
  readonly hostId: string;
  readonly existingRuleId: string | null;
  readonly rule: ProfileSyncRule | null;
  readonly hosts: ProfileCopyHosts;
  readonly candidates: readonly string[];
  readonly atCapacity: boolean;
  readonly providers: readonly ProviderCliState[];
  readonly close: () => void;
  readonly onSaved: (rule: ProfileSyncRule) => void;
}

function useProfileSyncRuleDraft(props: RuleEditorProps) {
  const id = useId();
  // Polling can remove a rule while its save is still running. Keep the
  // draft and mutation observer mounted, with the original CAS identity.
  const [originalRule] = useState(props.rule);
  const [ruleId, setRuleId] = useState(
    () => props.existingRuleId ?? crypto.randomUUID(),
  );
  const getSyncRuleId = useProfileCopyFlowStore((state) => state.getSyncRuleId);
  const [expectedRevision] = useState(() => ruleRevision(originalRule));
  const stopped = props.existingRuleId !== null && props.rule === null;
  const changed = ruleRevision(props.rule) !== expectedRevision;
  const [destination, setDestination] = useState(
    originalRule?.destinationHostId ?? "",
  );
  const [all, setAll] = useState(originalRule?.scope.kind === "all");
  const [chosenProviders, setSelected] = useState<ProfileCopyWireProvider[]>(
    originalRule?.scope.kind === "selected"
      ? [...originalRule.scope.providers]
      : [...PROFILE_COPY_PROVIDERS],
  );
  const selected = ruleProviders(
    originalRule,
    chosenProviders,
    props.providers,
  );
  const save = useProfileSyncSaveRule(props.hostId);
  const scope: ProfileSyncScope = all
    ? { kind: "all" }
    : { kind: "selected", providers: selected };
  const request: ProfileSyncSaveRule = {
    sourceHostId: props.hostId,
    ruleId,
    destinationHostId: destination,
    scope,
    paused: rulePaused(originalRule),
    expectedRevision,
  };
  const saveError = ruleSaveError(save.variables, request, save.error);
  const canSave = canSaveRule({
    rule: originalRule,
    changed: changed || stopped,
    destination,
    candidates: props.candidates,
    scope,
    pending: save.isPending,
  });
  return {
    id,
    originalRule,
    stopped,
    changed,
    destination,
    setDestination,
    all,
    setAll,
    selected,
    setSelected,
    save,
    request,
    saveError,
    canSave,
    submit: () => {
      if (!canSave) return;
      const submission = {
        ...request,
        ruleId:
          props.existingRuleId === null
            ? getSyncRuleId(props.hostId, destination)
            : ruleId,
      };
      setRuleId(submission.ruleId);
      save.mutate(submission, {
        onSuccess: (rule) => {
          props.onSaved(rule);
          props.close();
        },
      });
    },
  };
}

function ProfileSyncRuleEditor(props: RuleEditorProps): ReactNode {
  const {
    id,
    originalRule,
    stopped,
    changed,
    destination,
    setDestination,
    all,
    setAll,
    selected,
    setSelected,
    save,
    saveError,
    canSave,
    submit,
  } = useProfileSyncRuleDraft(props);
  if (stopped && !save.isPending && saveError === null)
    return (
      <div className="flex flex-col gap-4">
        <Button
          size="xs"
          variant="ghost"
          className="self-start"
          onClick={props.close}
        >
          ← Automatic sync
        </Button>
        <p role="alert" className="text-ui-xs text-destructive">
          This rule was stopped while you were editing.
        </p>
      </div>
    );
  return (
    <div className="flex flex-col gap-4">
      <div>
        <Button
          size="xs"
          variant="ghost"
          disabled={save.isPending}
          onClick={props.close}
        >
          ← Automatic sync
        </Button>
        <h3 className="mt-2 text-ui-sm font-medium">
          {props.existingRuleId === null
            ? "Add automatic sync"
            : "Edit automatic sync"}
        </h3>
      </div>
      <ProfileSyncRuleCapacity
        reached={props.existingRuleId === null && props.atCapacity}
      />
      <ProfileSyncRuleChangeNotice stopped={stopped} changed={changed} />
      <div className="flex flex-col gap-2">
        <span className="text-ui-xs text-muted-foreground">
          Destination device
        </span>
        <Select
          value={destination}
          onValueChange={setDestination}
          disabled={props.existingRuleId !== null || save.isPending}
        >
          <SelectTrigger className="w-full" aria-label="Destination device">
            <SelectValue placeholder="Choose a device" />
          </SelectTrigger>
          <SelectContent>
            {(originalRule !== null
              ? [originalRule.destinationHostId]
              : props.candidates
            ).map((id) => (
              <SelectItem key={id} value={id}>
                {props.hosts.nameFor(id)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <label htmlFor={id} className="flex items-start gap-2">
        <Checkbox
          id={id}
          checked={all}
          disabled={save.isPending}
          onCheckedChange={(v) => setAll(v === true)}
        />
        <span>
          <span className="text-ui-sm">
            All supported providers, including future providers
          </span>
          <p className="text-ui-xs text-muted-foreground">
            Otherwise choose providers below. Future profiles within your
            selection are included.
          </p>
        </span>
      </label>
      {!all ? (
        <ProfileSyncProviderPicker
          providers={props.providers}
          selected={selected}
          onChange={setSelected}
          disabled={save.isPending}
        />
      ) : null}
      <p className="text-ui-xs text-muted-foreground">
        Offline devices wait until both devices are connected. Profiles removed
        from the source or this rule stay on the destination.
      </p>
      {saveError ? (
        <p role="alert" className="text-ui-xs text-destructive">
          {profileCopyRequestErrorText(
            saveError,
            props.hosts.nameFor(props.hostId),
          )}
        </p>
      ) : null}
      <div className="flex justify-end gap-2">
        <Button
          variant="outline"
          disabled={save.isPending}
          onClick={props.close}
        >
          Cancel
        </Button>
        <Button disabled={!canSave} onClick={submit}>
          {save.isPending ? <MutedAgentSpinner /> : null}
          {props.existingRuleId === null
            ? "Enable automatic sync"
            : "Save changes"}
        </Button>
      </div>
    </div>
  );
}

function ProfileSyncRuleChangeNotice(props: {
  readonly stopped: boolean;
  readonly changed: boolean;
}): ReactNode {
  if (!props.stopped && !props.changed) return null;
  return (
    <p role="alert" className="text-ui-xs text-destructive">
      {props.stopped
        ? "This rule was stopped while you were editing."
        : "This rule changed while you were editing. Go back and reopen it to review the latest settings."}
    </p>
  );
}

function ProfileSyncRuleCapacity(props: {
  readonly reached: boolean;
}): ReactNode {
  return props.reached ? (
    <p role="status" className="text-ui-xs text-muted-foreground">
      {RULE_CAPACITY_NOTICE}
    </p>
  ) : null;
}

function ruleSaveError(
  request: ProfileSyncSaveRule | undefined,
  draft: ProfileSyncSaveRule,
  error: HostRpcError | null,
): HostRpcError | null {
  return request !== undefined && ruleSaveKey(request) === ruleSaveKey(draft)
    ? error
    : null;
}

function ruleSaveKey(request: ProfileSyncSaveRule): string {
  return JSON.stringify([
    request.sourceHostId,
    request.ruleId,
    request.destinationHostId,
    request.scope.kind,
    request.scope.kind === "selected"
      ? [...request.scope.providers].sort()
      : [],
    request.paused,
    request.expectedRevision,
  ]);
}

function canViewRuleRun(
  rule: ProfileSyncRule,
  batches: readonly ProfileSyncBatch[],
  sourceHostId: string,
): boolean {
  return (
    rule.batchId !== null &&
    batches.some(
      (batch) =>
        batch.batchId === rule.batchId &&
        batch.sourceHostId === sourceHostId &&
        batch.automatic &&
        batch.items.length > 0 &&
        batch.items.every(
          (item) => item.destinationHostId === rule.destinationHostId,
        ),
    )
  );
}

function canSaveRule({
  rule,
  changed,
  destination,
  candidates,
  scope,
  pending,
}: {
  readonly rule: ProfileSyncRule | null;
  readonly changed: boolean;
  readonly destination: string;
  readonly candidates: readonly string[];
  readonly scope: ProfileSyncScope;
  readonly pending: boolean;
}): boolean {
  return (
    !pending &&
    !changed &&
    destination.length > 0 &&
    (rule !== null || candidates.includes(destination)) &&
    (scope.kind === "all" || scope.providers.length > 0)
  );
}

function ruleProviders(
  rule: ProfileSyncRule | null,
  chosen: ProfileCopyWireProvider[],
  providers: readonly ProviderCliState[],
): ProfileCopyWireProvider[] {
  // Preserve saved explicit scopes, including providers that may return.
  // New explicit scopes, including conversions from all, use the catalog.
  if (rule?.scope.kind === "selected") return chosen;
  return chosen.filter((provider) =>
    providers.some((p) => profileCopyWireProvider(p.providerId) === provider),
  );
}

function ruleRevision(rule: ProfileSyncRule | null): number {
  return rule?.revision ?? 0;
}

function rulePaused(rule: ProfileSyncRule | null): boolean {
  return rule?.paused === true || rule?.status === "paused";
}

function ruleStatus(rule: ProfileSyncRule): string {
  if (rulePaused(rule)) return "Paused";
  if (rule.status === "waiting") return "Waiting for device";
  if (rule.status === "needs-action") return "Needs attention";
  return "Active";
}
