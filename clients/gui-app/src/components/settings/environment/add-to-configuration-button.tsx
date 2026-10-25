import { useState, type ReactNode } from "react";
import type { ProviderId } from "@traycer/protocol/host/provider-schemas";
import type { ProviderNativeScope } from "@traycer/protocol/host/provider-native-schemas";
import { PROMOTE_TO_PERSONAL_REQUIRED_HOST_VERSION } from "@traycer/protocol/host/registry";
import { negotiatedVersionMeetsRequirement } from "@traycer/protocol/host-transport/remote/rpc-types";
import { Button } from "@/components/ui/button";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { useHostNegotiatedMethodVersion } from "@/hooks/host/use-host-negotiated-method-version";
import { useProvidersPromoteToPersonal } from "@/hooks/providers/use-providers-promote-to-personal-mutation";
import { useHostClient } from "@/lib/host";
import { useConfigurationSource } from "./configuration-source";
import { addToConfigurationLabel } from "./mcp-skills-copy";

/**
 * "Add to <configuration>" on an entry a provider holds on one computer by
 * itself: the host uploads it into the configuration it serves, fenced to the
 * picked one. A refusal the host words (a name the configuration already
 * holds) shows beside the button as it reads. Shown only where the host takes
 * the promote.
 */
export function AddToConfigurationButton(props: {
  readonly entryKind: "mcp" | "skills";
  readonly providerId: ProviderId;
  /** Where the entry lives on this host: global, or the project at `workspaceRoot`. */
  readonly scope: ProviderNativeScope;
  readonly workspaceRoot: string | null;
  readonly name: string;
  readonly configurationName: string;
}): ReactNode {
  const source = useConfigurationSource();
  const version = useHostNegotiatedMethodVersion(
    useHostClient(),
    "providers.nativeMutate",
  );
  const promote = useProvidersPromoteToPersonal();
  const [refusal, setRefusal] = useState<string | null>(null);
  const supported =
    version !== null &&
    version !== false &&
    negotiatedVersionMeetsRequirement(
      version,
      PROMOTE_TO_PERSONAL_REQUIRED_HOST_VERSION,
    );
  if (!supported || source.kind !== "pool") return null;
  return (
    <span className="flex flex-wrap items-center gap-2">
      {refusal === null ? null : (
        <span role="status" className="text-ui-xs text-muted-foreground">
          {refusal}
        </span>
      )}
      <Button
        type="button"
        variant="link"
        size="inline-xs"
        disabled={promote.isPending}
        onClick={() => {
          setRefusal(null);
          promote.mutate(
            {
              providerId: props.providerId,
              mutation: {
                kind: "promoteToPersonal",
                entryKind: props.entryKind,
                scope: props.scope,
                workspaceRoot: props.workspaceRoot,
                name: props.name,
              },
              executableWriteGrant: null,
              expectedEnvironmentId: source.environmentId,
            },
            {
              onSuccess: (data) => {
                if (!data.result.ok) setRefusal(data.result.detail);
              },
            },
          );
        }}
      >
        {addToConfigurationLabel(props.configurationName)}
        {promote.isPending ? (
          <AgentSpinningDots
            className={undefined}
            testId={undefined}
            variant={undefined}
            tone="muted"
          />
        ) : null}
      </Button>
    </span>
  );
}
