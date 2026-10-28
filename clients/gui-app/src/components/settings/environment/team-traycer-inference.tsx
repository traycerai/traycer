import type { ReactNode } from "react";
import type { EnvironmentConfigurationItemWriteResponse } from "@traycer/protocol/host/environment/configuration-contracts";
import { Switch } from "@/components/ui/switch";
import { useConfigurationItemMutations } from "@/hooks/environment/team/use-configuration-item-mutations";
import {
  TRAYCER_INFERENCE_KEY,
  TRAYCER_INFERENCE_KIND,
  useEnvironmentTraycerInference,
} from "@/hooks/sandboxes/use-configuration-traycer-inference";
import { ConfigurationReadFailed } from "./team-read-failed";
import {
  useCanEditConfiguration,
  useConfigurationIsPersonal,
  useConfigurationSource,
} from "./configuration-source";

/**
 * Traycer Inference on or off for the whole configuration: every host running
 * it, sandboxes included, follows this switch. Editors and admins change it;
 * a viewer reads it. A host that cannot read the setting shows nothing, since
 * it could only guess.
 */
export function TeamTraycerInference(props: {
  readonly teamName: string;
  readonly onOutcome: (
    result: EnvironmentConfigurationItemWriteResponse,
  ) => void;
}): ReactNode {
  const source = useConfigurationSource();
  const personal = useConfigurationIsPersonal();
  const canEdit = useCanEditConfiguration();
  const environmentId = source.kind === "pool" ? source.environmentId : null;
  const read = useEnvironmentTraycerInference(environmentId);
  const { put } = useConfigurationItemMutations();
  if (environmentId === null) return null;
  if (read.kind === "pending" || read.kind === "unknown") return null;
  if (read.kind === "failed") {
    return <ConfigurationReadFailed page="providers" onRetry={read.retry} />;
  }
  return (
    <section className="flex items-start justify-between gap-3 rounded-lg border border-border/60 p-3">
      <div className="flex min-w-0 flex-col gap-1">
        <h3 className="text-ui-sm font-medium">Traycer Inference</h3>
        <p className="text-ui-xs text-muted-foreground">
          {`Lets agents on every host running ${personal ? "Personal" : props.teamName}, sandboxes included, run on Traycer Inference. Turns use credits.`}
        </p>
      </div>
      {canEdit ? (
        <Switch
          aria-label="Traycer Inference"
          checked={read.enabled}
          disabled={put.isPending}
          onCheckedChange={(enabled) =>
            put.mutate(
              {
                environmentId,
                kind: TRAYCER_INFERENCE_KIND,
                key: TRAYCER_INFERENCE_KEY,
                os: null,
                value: { enabled },
                revision: read.revision,
              },
              { onSuccess: props.onOutcome },
            )
          }
        />
      ) : (
        <span className="text-ui-sm text-muted-foreground">
          {read.enabled ? "On" : "Off"}
        </span>
      )}
    </section>
  );
}
