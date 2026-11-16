import { useId, useRef, useState, type ReactNode } from "react";
import type { UseQueryResult } from "@tanstack/react-query";
import { providerApiKeyRefusal } from "@traycer/protocol/host/provider-api-key-issuer";
import {
  PROVIDER_DISPLAY_NAMES,
  type ProviderId,
} from "@traycer/protocol/host/provider-schemas";
import {
  isProviderKeyProviderId,
  type ProviderKeyProviderId,
} from "@traycer-clients/shared/host-client/provider-api-key-change";
import type { EnvironmentProfileRecords } from "@traycer-clients/shared/host-client/profile-record-actions";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { MutedAgentSpinner } from "@/components/ui/agent-spinning-dots";
import { useSubmittedSecretInput } from "@/hooks/use-submitted-secret-input";
import { useBoundedRead } from "@/hooks/environment/team/use-bounded-read";
import { useCloudProviderApiKeyMutation } from "@/hooks/providers/use-cloud-provider-api-key-mutation";
import type { CloudProviderKeyScope } from "@/hooks/providers/use-cloud-provider-api-key-query";
import { ConfigurationReadFailed } from "./team-read-failed";

export function CloudProviderApiKeySection(props: {
  readonly scope: CloudProviderKeyScope;
  readonly providerId: ProviderId;
  readonly query: UseQueryResult<EnvironmentProfileRecords, HostRpcError>;
}): ReactNode {
  if (
    props.scope.environmentId === "" ||
    !isProviderKeyProviderId(props.providerId)
  )
    return null;
  return (
    <CloudProviderApiKeyField
      key={`${props.scope.viewerId}:${props.scope.identityGeneration}:${props.scope.environmentId}:${props.providerId}`}
      scope={props.scope}
      providerId={props.providerId}
      query={props.query}
    />
  );
}

function CloudProviderApiKeyField(props: {
  readonly scope: CloudProviderKeyScope;
  readonly providerId: ProviderKeyProviderId;
  readonly query: UseQueryResult<EnvironmentProfileRecords, HostRpcError>;
}): ReactNode {
  const inputId = useId();
  const [draft, setDraft] = useState("");
  const submitted = useSubmittedSecretInput<string>(
    "Couldn't save the API key.",
  );
  const outstanding = useRef(false);
  const mutation = useCloudProviderApiKeyMutation(
    props.scope,
    props.providerId,
    submitted.read,
    () => {
      submitted.clear();
      outstanding.current = false;
      setDraft("");
    },
  );
  const read = useBoundedRead(props.query);
  const list = props.query.isError ? undefined : props.query.data;
  if (list?.profileSyncEnabled === false) return null;
  if (read.failed)
    return <ConfigurationReadFailed page="keys" onRetry={read.retry} />;
  if (list === undefined) return read.pending ? <MutedAgentSpinner /> : null;
  const configured = list.providerKeys.some(
    (record) =>
      record.providerId === props.providerId && record.state === "live",
  );
  const refusal = providerApiKeyRefusal(props.providerId, draft);
  const disabled = !props.scope.canEdit || mutation.isPending;
  const change = (action: "set" | "clear"): void => {
    if (
      outstanding.current ||
      disabled ||
      (action === "set" && (draft.trim() === "" || refusal !== null))
    )
      return;
    outstanding.current = true;
    if (action === "set") submitted.set(draft.trim());
    mutation.mutate({ action });
  };
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border/60 p-3">
      <div className="flex items-center justify-between gap-2">
        <label
          htmlFor={inputId}
          className="text-ui-sm font-medium text-foreground"
        >
          API key
        </label>
        <span className="text-ui-xs text-muted-foreground">
          {configured ? "Key set" : "Not set"}
        </span>
      </div>
      <div className="flex items-center gap-2">
        <Input
          id={inputId}
          type="password"
          autoComplete="off"
          className="w-full"
          placeholder={
            configured
              ? "Replace stored key…"
              : `Paste your ${PROVIDER_DISPLAY_NAMES[props.providerId]} API key`
          }
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          disabled={disabled}
          aria-invalid={refusal !== null}
          aria-describedby={refusal === null ? undefined : `${inputId}-refusal`}
          onKeyDown={(event) => {
            if (event.key === "Enter") change("set");
          }}
          font="mono"
          size="sm"
        />
        <Button
          size="sm"
          variant="secondary"
          onClick={() => change("set")}
          disabled={disabled || draft.trim() === "" || refusal !== null}
        >
          {mutation.isPending && mutation.variables.action === "set" ? (
            <MutedAgentSpinner />
          ) : null}
          Save
        </Button>
        {configured ? (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => change("clear")}
            disabled={disabled}
          >
            {mutation.isPending && mutation.variables.action === "clear" ? (
              <MutedAgentSpinner />
            ) : null}
            Clear
          </Button>
        ) : null}
      </div>
      <p
        id={`${inputId}-refusal`}
        role="alert"
        hidden={refusal === null}
        className="text-ui-xs text-destructive"
      >
        {refusal}
      </p>
    </div>
  );
}
