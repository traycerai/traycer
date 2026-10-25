import { useState, type ReactNode } from "react";
import type { ProviderNativeScope } from "@traycer/protocol/host/provider-native-schemas";
import type { ProviderId } from "@traycer/protocol/host/provider-schemas";
import { PROMOTE_TO_PERSONAL_REQUIRED_HOST_VERSION } from "@traycer/protocol/host/registry";
import { negotiatedVersionMeetsRequirement } from "@traycer/protocol/host-transport/remote/rpc-types";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
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

/**
 * Whether an MCP server or skill on this host is one of the person's
 * settings, and if not, the one way to make it one.
 *
 * - Personal: the host applied one of the person's items as this entry
 *   (`environment.status` `appliedAs`; a client cannot compose a skill's
 *   item key, so the host's word is the only mark).
 * - Otherwise, at global scope: "On <host> only" with "Add to Personal",
 *   which a CLI- or agent-added entry needs before it goes anywhere else.
 * - Project scope: nothing. A project's entries stay with the project.
 *
 * Nothing on a host that is not set up for the person's settings.
 */
/** Which list a mark is drawn in: the entry kind, provider and scope. */
export interface PersonalMarkTarget {
  readonly entryKind: "mcp" | "skills";
  readonly providerId: ProviderId;
  readonly scope: ProviderNativeScope;
}

export function PersonalEntryMark(props: {
  readonly target: PersonalMarkTarget;
  readonly name: string;
}): ReactNode {
  const state = usePersonalHostState();
  const hostName = usePersonalHostName();
  const personal = usePersonalEntryApplied(
    props.target.entryKind,
    props.name,
    props.target.scope,
  );
  if (props.target.scope !== "global" || state?.kind !== "ready") return null;
  if (personal) {
    return (
      <Badge variant="secondary" data-testid="personal-entry-mark">
        Personal
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
      />
    </span>
  );
}

/**
 * Shown only where the host takes `promoteToPersonal`
 * (`PROMOTE_TO_PERSONAL_REQUIRED_HOST_VERSION`, nativeMutate 1.3). A host on
 * 1.2 or older refuses it.
 */
function AddToPersonalButton(props: {
  readonly entryKind: "mcp" | "skills";
  readonly providerId: ProviderId;
  readonly name: string;
}): ReactNode {
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
  if (!supported) return null;
  return (
    <>
      {/* A refusal the host words reads beside the button, as it reads. */}
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
              mutation: {
                kind: "promoteToPersonal",
                entryKind: props.entryKind,
                scope: "global",
                workspaceRoot: null,
                name: props.name,
              },
              executableWriteGrant: null,
              expectedEnvironmentId: null,
            },
            {
              onSuccess: (data) => {
                if (!data.result.ok) setRefusal(data.result.detail);
              },
            },
          );
        }}
      >
        Add to Personal
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
