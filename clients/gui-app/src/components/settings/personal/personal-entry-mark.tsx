import { useState, type ReactNode } from "react";
import type { EnvironmentStatusResponse } from "@traycer/protocol/host/environment-schemas";
import type { ProviderNativeScope } from "@traycer/protocol/host/provider-native-schemas";
import type { ProviderId } from "@traycer/protocol/host/provider-schemas";
import { PROMOTE_TO_PERSONAL_REQUIRED_HOST_VERSION } from "@traycer/protocol/host/registry";
import { negotiatedVersionMeetsRequirement } from "@traycer/protocol/host-transport/remote/rpc-types";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { addToConfigurationLabel } from "@/components/settings/environment/mcp-skills-copy";
import {
  usePersonalEntryApplied,
  usePersonalHostName,
  usePersonalHostState,
} from "@/components/settings/personal/personal-page-context";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useHostNegotiatedMethodVersion } from "@/hooks/host/use-host-negotiated-method-version";
import { useProvidersPromoteToPersonal } from "@/hooks/providers/use-providers-promote-to-personal-mutation";
import { useHostClient } from "@/lib/host";

/** Which list a mark is drawn in: the entry kind, provider and scope. */
export interface PersonalMarkTarget {
  readonly entryKind: "mcp" | "skills";
  readonly providerId: ProviderId;
  readonly scope: ProviderNativeScope;
}

/** The name of the environment this host serves: its team's, or "Personal". */
function servedEnvironmentName(status: EnvironmentStatusResponse): string {
  return status.principal?.kind === "team"
    ? status.principal.teamName
    : "Personal";
}

/**
 * Whether an MCP server or skill on this host is one of the settings of the
 * environment it serves, and if not, the one way to make it one.
 *
 * - In the environment: the host applied one of its items as this entry
 *   (`environment.status` `appliedAs`; a client cannot compose a skill's
 *   item key, so the host's word is the only mark), badged with its name.
 * - Otherwise, at global scope: "On <host> only" with "Add to <name>",
 *   which a CLI- or agent-added entry needs before it goes anywhere else.
 * - Project scope: nothing. A project's entries stay with the project.
 *
 * Nothing on a host that is not set up for an environment's settings.
 */
export function PersonalEntryMark(props: {
  readonly target: PersonalMarkTarget;
  readonly name: string;
}): ReactNode {
  const state = usePersonalHostState();
  const hostName = usePersonalHostName();
  const applied = usePersonalEntryApplied(
    props.target.entryKind,
    props.name,
    props.target.scope,
  );
  if (props.target.scope !== "global" || state?.kind !== "ready") return null;
  const environmentName = servedEnvironmentName(state.status);
  if (applied) {
    return (
      <Badge variant="secondary" data-testid="personal-entry-mark">
        {environmentName}
      </Badge>
    );
  }
  return (
    <span
      className="flex items-center gap-2 text-ui-xs text-muted-foreground"
      data-testid="local-entry-mark"
    >
      On {hostName ?? "this host"} only
      <AddToPersonalButton
        entryKind={props.target.entryKind}
        providerId={props.target.providerId}
        name={props.name}
        environmentName={environmentName}
      />
    </span>
  );
}

/**
 * "Add to <name>", for the environment this host serves. Shown only where the
 * host takes `promoteToPersonal` (`PROMOTE_TO_PERSONAL_REQUIRED_HOST_VERSION`,
 * nativeMutate 1.3). A host on 1.2 or older refuses it.
 */
export function AddToPersonalButton(props: {
  readonly entryKind: "mcp" | "skills";
  readonly providerId: ProviderId;
  readonly name: string;
  readonly environmentName: string;
}): ReactNode {
  const version = useHostNegotiatedMethodVersion(
    useHostClient(),
    "providers.nativeMutate",
  );
  const promote = useProvidersPromoteToPersonal(props.environmentName);
  const [refusal, setRefusal] = useState<string | null>(null);
  const supported =
    version !== null &&
    version !== false &&
    negotiatedVersionMeetsRequirement(
      version,
      PROMOTE_TO_PERSONAL_REQUIRED_HOST_VERSION,
    );
  if (!supported) return null;
  return (
    <>
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
        data-testid="add-to-personal"
        onClick={() => {
          setRefusal(null);
          promote.mutate(
            {
              providerId: props.providerId,
              entryKind: props.entryKind,
              scope: "global",
              workspaceRoot: null,
              name: props.name,
              expectedEnvironmentId: null,
            },
            {
              onSuccess: (outcome) => {
                if (outcome.kind === "refused") setRefusal(outcome.text);
              },
            },
          );
        }}
      >
        {addToConfigurationLabel(props.environmentName)}
        {promote.isPending ? (
          <AgentSpinningDots
            className={undefined}
            testId={undefined}
            variant={undefined}
            tone="muted"
          />
        ) : null}
      </Button>
    </>
  );
}
