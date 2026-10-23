import { useState, type ReactNode } from "react";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { EnvironmentSecret } from "@traycer/protocol/host/environment-schemas";
import { ReplaceSecretValueDialog } from "@/components/settings/secrets/replace-secret-value-dialog";
import { SecretRotationStatus } from "@/components/settings/secrets/secret-rotation-status";
import { SecretVersionsList } from "@/components/settings/secrets/secret-versions-list";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDestructiveDialog } from "@/components/ui/confirm-destructive-dialog";
import { useHostQuery } from "@/hooks/host/use-host-query";
import type { HostRpcRegistry } from "@/lib/host";
import {
  secretKindLabel,
  secretProtocolLabel,
} from "@/lib/sandboxes/secret-intake-copy";
import {
  secretVerifyLine,
  type SecretVerifyLine,
} from "@/lib/sandboxes/secret-verify-copy";
import {
  SECRET_PENDING_REVIEW_LABEL,
  SECRET_READABLE_WHERE,
  SECRET_RECOVERY_FALLBACK,
  SECRET_RECOVERY_STEPS,
  SECRET_RECOVERY_TITLE,
  SECRET_RESTART_LINE,
  SECRET_REVOKED_LABEL,
  secretRemovePreview,
} from "@/lib/sandboxes/secrets-page-copy";
import { cn } from "@/lib/utils";

const VERIFY_TONE: Readonly<Record<SecretVerifyLine["tone"], string>> = {
  success: "text-success-foreground",
  warning: "text-warning-foreground",
};

/** What a row says about its secret: kind, protocol and where it goes. */
function secretSummary(secret: EnvironmentSecret): string {
  const parts = [secretKindLabel(secret.kind)];
  if (secret.protocol !== null)
    parts.push(secretProtocolLabel(secret.protocol));
  if (secret.destinations.length > 0)
    parts.push(secret.destinations.join(", "));
  return parts.join(" · ");
}

function Spinner(props: { readonly busy: boolean }): ReactNode {
  return props.busy ? (
    <AgentSpinningDots
      className={undefined}
      testId={undefined}
      variant={undefined}
      tone="muted"
    />
  ) : null;
}

/** If the secret leaked: the order that closes it fastest. */
function RecoveryOrder(): ReactNode {
  return (
    <div className="flex flex-col gap-1" data-testid="secret-recovery">
      <p className="text-ui-xs font-medium text-foreground">
        {SECRET_RECOVERY_TITLE}
      </p>
      <ol className="flex list-decimal flex-col gap-0.5 pl-5 text-ui-xs text-muted-foreground">
        {SECRET_RECOVERY_STEPS.map((step) => (
          <li key={step} className="max-w-[72ch]">
            {step}
          </li>
        ))}
      </ol>
      <p className="max-w-[72ch] text-ui-xs text-muted-foreground">
        {SECRET_RECOVERY_FALLBACK}
      </p>
    </div>
  );
}

/**
 * One secret on Settings ▸ Personal ▸ Secrets: its name, what it is and
 * where it goes, where its value is readable, Verify, Replace value with the
 * replacement's progress, Remove's confirmation, and its versions with the
 * recovery order. No value is ever here. Verify and the versions act on the
 * secret by id, so they work for every kind, those already stored included.
 * A held secret's pending-review badge stays; P5 adds its verbs.
 */
export function SecretRow(props: {
  readonly secret: EnvironmentSecret;
  readonly client: HostClient<HostRpcRegistry>;
  readonly hostId: string | null;
  readonly hostName: (hostId: string) => string;
  /** Something about this secret changed: the list re-reads. */
  readonly onChanged: () => void;
}): ReactNode {
  const { secret } = props;
  const [verifying, setVerifying] = useState(false);
  const [line, setLine] = useState<SecretVerifyLine | null>(null);
  const [replacing, setReplacing] = useState(false);
  const [removing, setRemoving] = useState(false);
  // Each accepted replacement remounts the status, so it reads the new
  // rotation from the start and re-reads it until it settles.
  const [replacements, setReplacements] = useState(0);
  const [showVersions, setShowVersions] = useState(false);
  const versions = useHostQuery<
    HostRpcRegistry,
    "environment.secrets.versions"
  >({
    cacheKeyIdentity: undefined,
    client: props.client,
    method: "environment.secrets.versions",
    params: { secretId: secret.secretId, environmentId: null },
    options: { enabled: removing },
  });
  const currentVersion = (versions.data?.versions ?? []).find(
    (version) => version.current,
  );
  const versionLabel =
    currentVersion === undefined ? "unknown" : String(currentVersion.ordinal);

  const verify = async (): Promise<void> => {
    setVerifying(true);
    setLine(null);
    try {
      const result = await props.client.request("environment.secrets.verify", {
        target: "secret",
        secretId: secret.secretId,
        environmentId: null,
      });
      setLine(secretVerifyLine(result, secret.protocol ?? "", "row"));
    } catch (error) {
      setLine({
        tone: "warning",
        text: error instanceof Error ? error.message : "Couldn't check.",
      });
    } finally {
      setVerifying(false);
    }
  };

  return (
    <li
      className="flex flex-col gap-1.5 border-b border-border/60 py-3 last:border-b-0"
      data-testid="secret-row"
      data-secret-name={secret.name}
    >
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-ui-sm text-foreground">
              {secret.name}
            </span>
            {secret.revoked ? (
              <Badge variant="outline">{SECRET_REVOKED_LABEL}</Badge>
            ) : null}
            {!secret.revoked && secret.state === "pending_review" ? (
              <Badge variant="outline">{SECRET_PENDING_REVIEW_LABEL}</Badge>
            ) : null}
          </span>
          <span className="min-w-0 text-ui-xs text-muted-foreground">
            {secretSummary(secret)}
          </span>
        </div>
        <div className="flex shrink-0 flex-wrap gap-1">
          {secret.revoked ? null : (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={verifying}
              onClick={() => void verify()}
              data-testid="secret-row-verify"
            >
              Verify
              <Spinner busy={verifying} />
            </Button>
          )}
          {secret.revoked || secret.currentVersionId === null ? null : (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => setReplacing(true)}
              data-testid="secret-row-replace"
            >
              Replace value
            </Button>
          )}
          <Button
            type="button"
            size="sm"
            variant="ghost"
            aria-expanded={showVersions}
            onClick={() => setShowVersions((open) => !open)}
            data-testid="secret-row-versions"
          >
            Versions
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => setRemoving(true)}
            data-testid="secret-row-remove"
          >
            Remove
          </Button>
        </div>
      </div>
      {secret.revoked ? null : (
        <p className="max-w-[72ch] text-ui-xs text-muted-foreground">
          {SECRET_READABLE_WHERE}
        </p>
      )}
      {line === null ? null : (
        <p
          role="status"
          className={cn("max-w-[72ch] text-ui-xs", VERIFY_TONE[line.tone])}
          data-testid="secret-verify-line"
        >
          {line.text}
        </p>
      )}
      {replacements > 0 || showVersions ? (
        <SecretRotationStatus
          key={replacements}
          client={props.client}
          secretId={secret.secretId}
          hostName={props.hostName}
        />
      ) : null}
      {replacements > 0 ? (
        <p
          className="max-w-[72ch] text-ui-xs text-muted-foreground"
          data-testid="secret-restart-line"
        >
          {SECRET_RESTART_LINE}
        </p>
      ) : null}
      {showVersions ? (
        <div className="flex flex-col gap-3 pl-3">
          <SecretVersionsList
            secret={secret}
            client={props.client}
            hostId={props.hostId}
            onChanged={props.onChanged}
          />
          <RecoveryOrder />
        </div>
      ) : null}
      <ReplaceSecretValueDialog
        open={replacing}
        secret={secret}
        client={props.client}
        onOpenChange={setReplacing}
        onReplaced={() => {
          setReplacements((count) => count + 1);
          props.onChanged();
        }}
        onStale={props.onChanged}
      />
      <ConfirmDestructiveDialog
        open={removing}
        onOpenChange={setRemoving}
        title={`Remove ${secret.name}?`}
        description={secretRemovePreview({
          origin: "unknown",
          version: versionLabel,
          hosts: "unknown",
        })}
        cascadeSummary={null}
        actionLabel="Remove"
        isPending={false}
        blockedReason={null}
        onConfirm={() => {
          // No `environment.secrets.remove` on the wire yet (P3 owns the
          // three Remove outcomes; E3p owns the method). Confirm closes
          // without a call so the preview is reachable.
          setRemoving(false);
        }}
      />
    </li>
  );
}
