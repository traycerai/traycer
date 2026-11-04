/**
 * Docs: see ../SETTINGS.md (Environment ▸ Storage).
 * Update that file whenever this settings surface changes.
 */
import type { ReactNode } from "react";
import { STORAGE } from "@/components/settings/environment/storage-page.definitions";
import { configurationWriteIssue } from "@/components/settings/environment/configuration-write-issue";
import { ConfigurationWriteFeedback } from "@/components/settings/environment/configuration-write-feedback";
import { SettingsRow } from "@/components/settings/settings-row";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { useCloudChatViewerId } from "@/hooks/chats/use-cloud-chat-queries";
import { useConfigurationItemMutations } from "@/hooks/environment/team/use-configuration-item-mutations";
import {
  STORAGE_POLICY_KEY,
  STORAGE_POLICY_KIND,
  storagePolicyValueSchema,
  useConfigurationStoragePolicy,
} from "@/hooks/environment/use-storage-policy";
import { useHostSupportsMethod } from "@/hooks/host/use-host-supports-method";
import { useReactiveHostReadiness } from "@/hooks/host/use-reactive-host-readiness";
import { trackSettingChanged } from "@/lib/analytics";
import { useHostClient } from "@/lib/host";
import type { EnvironmentPick } from "@/lib/settings-environment-pages";

const FREE_UP_SPACE_FOOTNOTE =
  "Runs only when the disk is getting full. A chat comes back when an agent continues it.";

/**
 * Environment ▸ Storage ▸ "Free up space on this computer": the picked
 * configuration's `storage_policy` item, on while none is set.
 *
 * Rendered only when the surface's host advertises the item write
 * (`environment.configuration.items.put`, answered by the pool in a pool
 * build): an older host draws nothing. The host is the one the write is sent
 * through (`useConfigurationItemMutations`). Keyed by the viewer, as the
 * auto-archive row is: the save in flight and its outcome belong to the
 * person using the row, so an account switch with Settings open starts the
 * row over instead of showing the outgoing account's save.
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
  const issue =
    put.data === undefined ? null : configurationWriteIssue(put.data);
  // The save in flight while there is one, else what was read: a refused save
  // drops back to the value read, and the hook's toast says why.
  const pending = put.isPending
    ? storagePolicyValueSchema.safeParse(put.variables.value)
    : null;
  const policy = read.data;
  const shown =
    pending !== null && pending.success
      ? pending.data.freeUpSpace
      : (policy?.freeUpSpace ?? true);
  const disabled =
    environment === null ||
    environment.role === "viewer" ||
    policy === undefined ||
    put.isPending;
  return (
    <section
      aria-label="Storage"
      className="flex flex-col border-b border-border/60"
      data-testid="storage-free-up-space"
    >
      <SettingsRow
        row={STORAGE.definitions.freeUpSpace}
        status={
          read.isError ? (
            <div className="flex flex-col gap-1">
              <p>{STORAGE.definitions.freeUpSpace.description}</p>
              <div className="flex flex-wrap items-center gap-2">
                <p role="status">Couldn&apos;t read this setting.</p>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    void read.refetch();
                  }}
                >
                  Retry
                </Button>
              </div>
            </div>
          ) : undefined
        }
        control={
          <div className="flex items-center gap-2">
            {put.isPending ? (
              <AgentSpinningDots
                className={undefined}
                testId="storage-free-up-space-saving"
                variant={undefined}
              />
            ) : null}
            <Switch
              checked={shown}
              disabled={disabled}
              aria-label={STORAGE.definitions.freeUpSpace.label}
              onCheckedChange={(freeUpSpace) => {
                if (environment === null || policy === undefined) return;
                trackSettingChanged("storage", "freeUpSpace");
                put.mutate({
                  environmentId: environment.environmentId,
                  kind: STORAGE_POLICY_KIND,
                  key: STORAGE_POLICY_KEY,
                  os: null,
                  value: { freeUpSpace },
                  revision: policy.revision,
                });
              }}
            />
          </div>
        }
        details={
          shown ? (
            <div className="flex flex-col gap-2">
              <p className="flex items-center gap-2 text-ui-xs text-muted-foreground">
                <span
                  aria-hidden
                  className="size-1.5 shrink-0 rounded-full bg-success"
                />
                {FREE_UP_SPACE_FOOTNOTE}
              </p>
              <ConfigurationWriteFeedback issue={issue} />
            </div>
          ) : (
            <ConfigurationWriteFeedback issue={issue} />
          )
        }
      />
    </section>
  );
}
