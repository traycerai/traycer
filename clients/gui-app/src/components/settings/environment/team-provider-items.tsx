import { z } from "zod";
import { useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { MutedAgentSpinner } from "@/components/ui/agent-spinning-dots";
import type { EnvironmentConfigurationItemWriteResponse } from "@traycer/protocol/host/environment/configuration-contracts";
import { useConfigurationItemMutations } from "@/hooks/environment/team/use-configuration-item-mutations";
import {
  configurationProfileValueSchema,
  configurationPackValueSchema,
} from "@/hooks/environment/team/configuration-item-values";
import type { ConfigurationItem } from "@/hooks/environment/team/use-configuration-items-query";
import {
  useCanEditConfiguration,
  useConfigurationSource,
} from "./configuration-source";

export function TeamProfileItem(props: {
  readonly item: ConfigurationItem;
  readonly onOutcome: (
    result: EnvironmentConfigurationItemWriteResponse,
  ) => void;
  readonly details: ReactNode;
}): ReactNode {
  const source = useConfigurationSource();
  const canEdit = useCanEditConfiguration();
  const { put } = useConfigurationItemMutations();
  const profile = configurationProfileValueSchema.parse(props.item.value);
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border/60 p-3">
      <div>
        <p className="text-ui-sm font-medium">{profile.name}</p>
        <p className="text-ui-xs text-muted-foreground">
          {profile.accountIdentity}
        </p>
      </div>
      <div className="flex items-center gap-2">
        {props.details}
        {canEdit ? (
          <Switch
            aria-label={`Use ${profile.name}`}
            checked={profile.enabled}
            disabled={put.isPending}
            onCheckedChange={(enabled) => {
              if (source.kind === "pool")
                put.mutate(
                  {
                    environmentId: source.environmentId,
                    kind: "managed_profile",
                    key: props.item.key,
                    os: null,
                    value: {
                      ...z.record(z.string(), z.json()).parse(props.item.value),
                      enabled,
                    },
                    revision: props.item.revision,
                  },
                  { onSuccess: props.onOutcome },
                );
            }}
          />
        ) : (
          <span className="text-ui-xs text-muted-foreground">
            {profile.enabled ? "On" : "Off"}
          </span>
        )}
      </div>
    </div>
  );
}

export function TeamPackItem(props: {
  readonly packId: string;
  readonly item: ConfigurationItem | null;
  readonly onOutcome: (
    result: EnvironmentConfigurationItemWriteResponse,
  ) => void;
}): ReactNode {
  const source = useConfigurationSource();
  const canEdit = useCanEditConfiguration();
  const { put } = useConfigurationItemMutations();
  const saved =
    props.item === null
      ? { pinnedVersion: null, autoDownload: true }
      : configurationPackValueSchema.parse(props.item.value);
  const [version, setVersion] = useState(saved.pinnedVersion ?? "");
  const [autoDownload, setAutoDownload] = useState(saved.autoDownload);
  const changed =
    version !== (saved.pinnedVersion ?? "") ||
    autoDownload !== saved.autoDownload;
  if (!canEdit)
    return (
      <p className="text-ui-sm">
        {props.packId}: {saved.pinnedVersion ?? "Latest"} ·{" "}
        {saved.autoDownload ? "Downloads automatically" : "Manual download"}
      </p>
    );
  return (
    <section className="flex flex-col gap-3 rounded-lg border border-border/60 p-3">
      <h3 className="text-ui-sm font-medium">{props.packId}</h3>
      <Input
        aria-label={`${props.packId} pinned version`}
        placeholder="Latest"
        value={version}
        onChange={(event) => setVersion(event.target.value)}
      />
      <div className="flex items-center justify-between gap-3">
        <span className="text-ui-sm">Download updates automatically</span>
        <Switch
          aria-label="Download pack updates automatically"
          checked={autoDownload}
          onCheckedChange={setAutoDownload}
          disabled={put.isPending}
        />
      </div>
      <Button
        type="button"
        size="sm"
        className="self-end"
        disabled={!changed || put.isPending}
        onClick={() => {
          if (source.kind === "pool")
            put.mutate(
              {
                environmentId: source.environmentId,
                kind: "pack_policy",
                key: props.packId,
                os: null,
                value: { pinnedVersion: version.trim() || null, autoDownload },
                revision: props.item?.revision ?? null,
              },
              { onSuccess: props.onOutcome },
            );
        }}
      >
        Save{put.isPending ? <MutedAgentSpinner /> : null}
      </Button>
    </section>
  );
}
