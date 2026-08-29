import { useState, type ReactNode } from "react";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcRegistry } from "@traycer/protocol/host/index";
import {
  MAX_ARTIFACT_VERSION_BYTES_PER_ARTIFACT,
  MAX_ARTIFACT_VERSION_RETENTION_DAYS,
  MAX_ARTIFACT_VERSIONS_PER_ARTIFACT,
  type ArtifactVersionSettings,
  type ArtifactVersionSettingsCommandResponse,
} from "@traycer/protocol/host/epic/artifact-versions";
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
import { Switch } from "@/components/ui/switch";
import { SettingsGroup } from "@/components/settings/settings-group";
import { SettingsRow } from "@/components/settings/settings-row";
import { useHostQuery } from "@/hooks/host/use-host-query";
import { useHostScopedMutationForClient } from "@/hooks/host/use-host-scoped-mutation";
import { useHostSupportsMethod } from "@/hooks/host/use-host-supports-method";
import { epicMutationKeys } from "@/lib/query-keys/epic-mutation-keys";

type ConfirmAction = "disable" | "retention" | "clear" | null;

interface PendingConfirmation {
  readonly hostId: string | null;
  readonly action: Exclude<ConfirmAction, null>;
}

interface RetentionDraft {
  readonly hostId: string | null;
  readonly retentionDays: string | null;
  readonly maxVersions: string | null;
  readonly maxMegabytes: string | null;
}

function confirmTitle(action: ConfirmAction): string {
  if (action === "disable") return "Turn off version history?";
  if (action === "retention") return "Tighten retention?";
  return "Clear version history?";
}

function confirmDescription(
  action: ConfirmAction,
  reclaimableBytes: number,
): string {
  if (action === "disable") {
    return "Edits made while history is off are never recoverable. On a Sync plan, this host's edits will produce no cloud history either. Existing saved versions remain available.";
  }
  if (action === "retention") {
    return "Observations beyond the new age, version-count, or per-artifact byte limits will be pruned immediately. This cannot be undone.";
  }
  return `${formatBytes(reclaimableBytes)} is reclaimable and will be removed. Checkpoint-owned blobs remain because checkpoints still reference them.`;
}

function confirmButtonLabel(action: ConfirmAction): string {
  if (action === "disable") return "Turn off";
  if (action === "retention") return "Prune and save";
  return "Clear reclaimable history";
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 * 1024 * 1024)
    return `${(value / (1024 * 1024)).toFixed(1)} MB`;
  return `${(value / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

const MAX_ARTIFACT_VERSION_MEGABYTES_PER_ARTIFACT = Math.floor(
  MAX_ARTIFACT_VERSION_BYTES_PER_ARTIFACT / (1024 * 1024),
);

function boundedInteger(
  value: string,
  fallback: number,
  maximum: number,
): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= maximum
    ? parsed
    : fallback;
}

function commandEffectCopy(
  result: ArtifactVersionSettingsCommandResponse,
): string {
  const effects = result.effects;
  if (effects.captureStopped) return "Capture stopped on this host.";
  if (effects.captureResumed) {
    return effects.driftEpicIds.length === 0
      ? "Capture resumed on this host."
      : `Capture resumed. ${effects.driftEpicIds.length} ${effects.driftEpicIds.length === 1 ? "task has" : "tasks have"} edits made while history was off.`;
  }
  if (effects.observationsPruned > 0 || effects.bytesDeleted > 0) {
    return `${effects.observationsPruned} ${effects.observationsPruned === 1 ? "observation" : "observations"} pruned; ${formatBytes(effects.bytesDeleted)} reclaimed.`;
  }
  return "Version history settings saved.";
}

// This section keeps three narrow command states visible alongside one shared
// committed snapshot; the branching reflects those distinct protocol effects.
// eslint-disable-next-line complexity
export function ArtifactVersionSettingsSection(props: {
  readonly client: HostClient<HostRpcRegistry> | null;
  readonly hostId: string | null;
  readonly enabled: boolean;
}): ReactNode {
  const supportsGet = useHostSupportsMethod(
    props.hostId,
    "epic.artifactVersionSettings.get",
  );
  const supportsEnabled = useHostSupportsMethod(
    props.hostId,
    "epic.artifactVersionSettings.setEnabled",
  );
  const supportsRetention = useHostSupportsMethod(
    props.hostId,
    "epic.artifactVersionSettings.setRetentionPolicy",
  );
  const supportsClear = useHostSupportsMethod(
    props.hostId,
    "epic.artifactVersionSettings.clearHistory",
  );
  const supported =
    supportsGet && supportsEnabled && supportsRetention && supportsClear;
  const query = useHostQuery({
    client: props.client,
    method: "epic.artifactVersionSettings.get",
    params: {},
    cacheKeyIdentity: undefined,
    options: { enabled: props.enabled && supported },
  });
  const [committed, setCommitted] = useState<{
    readonly hostId: string | null;
    readonly response: ArtifactVersionSettingsCommandResponse;
  } | null>(null);
  const [confirm, setConfirm] = useState<PendingConfirmation | null>(null);
  const [retentionDraft, setRetentionDraft] = useState<RetentionDraft | null>(
    null,
  );

  const setEnabled = useHostScopedMutationForClient(props.client, {
    method: "epic.artifactVersionSettings.setEnabled",
    mutationKey: epicMutationKeys.setArtifactVersionCaptureEnabled(),
    errorMessage: "Couldn't update version history",
    invalidateMethods: ["epic.artifactVersionSettings.get"],
    onSuccess: (result) =>
      setCommitted({ hostId: props.hostId, response: result }),
  });
  const setRetention = useHostScopedMutationForClient(props.client, {
    method: "epic.artifactVersionSettings.setRetentionPolicy",
    mutationKey: epicMutationKeys.setArtifactVersionRetentionPolicy(),
    errorMessage: "Couldn't update the retention policy",
    invalidateMethods: [
      "epic.artifactVersionSettings.get",
      "epic.artifactVersions.list",
      "epic.deletedArtifacts.list",
    ],
    onSuccess: (result) => {
      setCommitted({ hostId: props.hostId, response: result });
      setRetentionDraft((current) =>
        current?.hostId === props.hostId ? null : current,
      );
    },
  });
  const clearHistory = useHostScopedMutationForClient(props.client, {
    method: "epic.artifactVersionSettings.clearHistory",
    mutationKey: epicMutationKeys.clearArtifactVersionHistory(),
    errorMessage: "Couldn't clear version history",
    invalidateMethods: [
      "epic.artifactVersionSettings.get",
      "epic.artifactVersions.list",
      "epic.deletedArtifacts.list",
    ],
    onSuccess: (result) =>
      setCommitted({ hostId: props.hostId, response: result }),
  });

  if (!supported) return null;
  const committedForHost =
    committed?.hostId === props.hostId ? committed.response : null;
  const snapshot = query.data ?? committedForHost;
  if (snapshot === null) {
    return (
      <SettingsGroup
        title="Version history"
        tone="default"
        dataTestId="artifact-version-settings"
        fill={false}
      >
        <p className="px-5 py-4 text-muted-foreground">
          {query.isError
            ? "Version history settings are unavailable."
            : "Loading version history settings…"}
        </p>
      </SettingsGroup>
    );
  }

  const settings = snapshot.settings;
  const currentRetentionDraft =
    retentionDraft?.hostId === props.hostId ? retentionDraft : null;
  const retentionDays = currentRetentionDraft?.retentionDays ?? null;
  const maxVersions = currentRetentionDraft?.maxVersions ?? null;
  const maxMegabytes = currentRetentionDraft?.maxMegabytes ?? null;
  const confirmForHost =
    confirm?.hostId === props.hostId ? confirm.action : null;
  const updateRetentionDraft = (
    field: "retentionDays" | "maxVersions" | "maxMegabytes",
    value: string,
  ): void => {
    setRetentionDraft((current) => {
      const currentForHost = current?.hostId === props.hostId ? current : null;
      return {
        hostId: props.hostId,
        retentionDays: currentForHost?.retentionDays ?? null,
        maxVersions: currentForHost?.maxVersions ?? null,
        maxMegabytes: currentForHost?.maxMegabytes ?? null,
        [field]: value,
      };
    });
  };
  const draft: ArtifactVersionSettings = {
    enabled: settings.enabled,
    retentionDays: boundedInteger(
      retentionDays ?? "",
      settings.retentionDays,
      MAX_ARTIFACT_VERSION_RETENTION_DAYS,
    ),
    maxVersionsPerArtifact: boundedInteger(
      maxVersions ?? "",
      settings.maxVersionsPerArtifact,
      MAX_ARTIFACT_VERSIONS_PER_ARTIFACT,
    ),
    maxBytesPerArtifact:
      maxMegabytes === null
        ? settings.maxBytesPerArtifact
        : boundedInteger(
            maxMegabytes,
            Math.ceil(settings.maxBytesPerArtifact / (1024 * 1024)),
            MAX_ARTIFACT_VERSION_MEGABYTES_PER_ARTIFACT,
          ) *
          1024 *
          1024,
  };
  const tightensRetention =
    draft.retentionDays < settings.retentionDays ||
    draft.maxVersionsPerArtifact < settings.maxVersionsPerArtifact ||
    draft.maxBytesPerArtifact < settings.maxBytesPerArtifact;
  const retentionChanged =
    draft.retentionDays !== settings.retentionDays ||
    draft.maxVersionsPerArtifact !== settings.maxVersionsPerArtifact ||
    draft.maxBytesPerArtifact !== settings.maxBytesPerArtifact;
  const pending =
    setEnabled.isPending || setRetention.isPending || clearHistory.isPending;

  const commitRetention = (): void => {
    if (retentionDraft?.hostId !== props.hostId) return;
    setConfirm(null);
    setRetention.mutate({
      retentionDays: draft.retentionDays,
      maxVersionsPerArtifact: draft.maxVersionsPerArtifact,
      maxBytesPerArtifact: draft.maxBytesPerArtifact,
    });
  };

  return (
    <>
      <SettingsGroup
        title="Version history"
        tone="default"
        dataTestId="artifact-version-settings"
        fill={false}
      >
        <SettingsRow
          label="Capture versions"
          description="Save restorable observations of artifact edits on this host."
          control={
            <Switch
              checked={settings.enabled}
              disabled={pending}
              aria-label="Capture artifact versions"
              onCheckedChange={(checked) => {
                if (checked) setEnabled.mutate({ enabled: true });
                else setConfirm({ hostId: props.hostId, action: "disable" });
              }}
            />
          }
        />
        <SettingsRow
          label="Retention"
          description="History is pruned when any per-artifact limit is reached."
          control={
            <div className="grid w-full max-w-md grid-cols-3 gap-2">
              <label
                htmlFor="artifact-retention-days"
                className="space-y-1 text-ui-xs text-muted-foreground"
              >
                Days
                <Input
                  id="artifact-retention-days"
                  type="number"
                  min={1}
                  max={MAX_ARTIFACT_VERSION_RETENTION_DAYS}
                  value={retentionDays ?? String(settings.retentionDays)}
                  onChange={(event) =>
                    updateRetentionDraft("retentionDays", event.target.value)
                  }
                />
              </label>
              <label
                htmlFor="artifact-retention-versions"
                className="space-y-1 text-ui-xs text-muted-foreground"
              >
                Versions
                <Input
                  id="artifact-retention-versions"
                  type="number"
                  min={1}
                  max={MAX_ARTIFACT_VERSIONS_PER_ARTIFACT}
                  value={maxVersions ?? String(settings.maxVersionsPerArtifact)}
                  onChange={(event) =>
                    updateRetentionDraft("maxVersions", event.target.value)
                  }
                />
              </label>
              <label
                htmlFor="artifact-retention-megabytes"
                className="space-y-1 text-ui-xs text-muted-foreground"
              >
                MB
                <Input
                  id="artifact-retention-megabytes"
                  type="number"
                  min={1}
                  max={MAX_ARTIFACT_VERSION_MEGABYTES_PER_ARTIFACT}
                  value={
                    maxMegabytes ??
                    String(
                      Math.ceil(settings.maxBytesPerArtifact / (1024 * 1024)),
                    )
                  }
                  onChange={(event) =>
                    updateRetentionDraft("maxMegabytes", event.target.value)
                  }
                />
              </label>
              <Button
                className="col-span-3 justify-self-end"
                size="sm"
                variant="outline"
                disabled={!retentionChanged || pending}
                onClick={() => {
                  if (tightensRetention) {
                    setConfirm({
                      hostId: props.hostId,
                      action: "retention",
                    });
                  } else commitRetention();
                }}
              >
                Save retention
              </Button>
            </div>
          }
        />
        <SettingsRow
          label="Storage"
          description="Referenced history is retained; reclaimable bytes can be cleared now."
          control={
            <div className="text-right text-ui-sm">
              <p>{formatBytes(snapshot.storage.referencedBytes)} referenced</p>
              <p className="text-muted-foreground">
                {formatBytes(snapshot.storage.reclaimableBytes)} reclaimable
              </p>
            </div>
          }
        />
        <SettingsRow
          label="Clear version history"
          description="Remove all version-history records from this host; only unreferenced content bytes are reclaimed."
          control={
            <Button
              size="sm"
              variant="outline"
              disabled={pending}
              onClick={() =>
                setConfirm({ hostId: props.hostId, action: "clear" })
              }
            >
              Clear version history…
            </Button>
          }
        />
        {committedForHost === null ? null : (
          <p className="border-t border-border/40 px-5 py-3 text-ui-xs text-muted-foreground">
            {commandEffectCopy(committedForHost)} Current policy:{" "}
            {committedForHost.settings.retentionDays} days,{" "}
            {committedForHost.settings.maxVersionsPerArtifact} versions,{" "}
            {formatBytes(committedForHost.settings.maxBytesPerArtifact)} per
            artifact.
          </p>
        )}
      </SettingsGroup>

      <Dialog
        open={confirmForHost !== null}
        onOpenChange={(open) => !open && setConfirm(null)}
      >
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{confirmTitle(confirmForHost)}</DialogTitle>
            <DialogDescription>
              {confirmDescription(
                confirmForHost,
                snapshot.storage.reclaimableBytes,
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirm(null)}>
              Cancel
            </Button>
            <Button
              variant={confirmForHost === "clear" ? "destructive" : "default"}
              disabled={pending}
              onClick={() => {
                if (confirm?.hostId !== props.hostId) return;
                if (confirm.action === "disable") {
                  setConfirm(null);
                  setEnabled.mutate({ enabled: false });
                } else if (confirm.action === "retention") {
                  commitRetention();
                } else {
                  setConfirm(null);
                  clearHistory.mutate({});
                }
              }}
            >
              {confirmButtonLabel(confirmForHost)}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
