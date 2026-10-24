import { useState, type ReactNode } from "react";
import {
  HostMethodVersionUnsatisfiedError,
  type ResponseOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type {
  EnvironmentSecretsVerifyResponse,
  EnvironmentSecret,
} from "@traycer/protocol/host/environment-schemas";
import { ReplaceSecretValueDialog } from "@/components/settings/secrets/replace-secret-value-dialog";
import { SecretRotationStatus } from "@/components/settings/secrets/secret-rotation-status";
import { SecretVersionsList } from "@/components/settings/secrets/secret-versions-list";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDestructiveDialog } from "@/components/ui/confirm-destructive-dialog";
import { useSecretRowActions } from "@/components/settings/secrets/use-secret-row-actions";
import { SecretRemovalStatus } from "@/components/settings/secrets/secret-removal-status";
import { SettingsDetailsButton } from "@/components/settings/details/settings-details-button";
import { useDetailsEnvironmentId } from "@/components/settings/details/use-details-environment-id";
import { secretChangeRefusalLine } from "@/lib/sandboxes/secret-change-refusal-copy";
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
  SECRETS_NEED_UPDATED_HOST,
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

function verifyFeedback(
  answer: EnvironmentSecretsVerifyResponse | undefined,
  error: Error | null,
  protocol: string | null,
): SecretVerifyLine | null {
  if (error !== null) return { tone: "warning", text: error.message };
  if (answer === undefined) return null;
  return secretVerifyLine(answer, protocol ?? "", "row");
}

function removalFailure(
  answer:
    | ResponseOfMethod<HostRpcRegistry, "environment.secrets.destroy">
    | undefined,
  error: Error | null,
): string | null {
  if (error instanceof HostMethodVersionUnsatisfiedError)
    return SECRETS_NEED_UPDATED_HOST;
  if (error !== null) return error.message;
  if (answer?.outcome === "refused")
    return (
      secretChangeRefusalLine("destroy", answer.code) ??
      "That didn't go through."
    );
  return null;
}

function removeBlockedReason(
  error: Error | null,
  fetching: boolean,
  versionId: string | null,
): string | null {
  if (error !== null) return error.message;
  if (fetching) return "Checking the current version.";
  return versionId === null ? "There is no current version to remove." : null;
}

function SecretRowIdentity(props: {
  readonly secret: EnvironmentSecret;
  readonly revoked: boolean;
}): ReactNode {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <span className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-ui-sm text-foreground">
          {props.secret.name}
        </span>
        {props.revoked ? (
          <Badge variant="outline">{SECRET_REVOKED_LABEL}</Badge>
        ) : null}
        {!props.revoked && props.secret.state === "pending_review" ? (
          <Badge variant="outline">{SECRET_PENDING_REVIEW_LABEL}</Badge>
        ) : null}
      </span>
      <span className="min-w-0 text-ui-xs text-muted-foreground">
        {secretSummary(props.secret)}
      </span>
    </div>
  );
}

function SecretRowControls(props: {
  readonly revoked: boolean;
  readonly hasVersion: boolean;
  readonly verifying: boolean;
  readonly removing: boolean;
  readonly showVersions: boolean;
  readonly details: ReactNode;
  readonly onVerify: () => void;
  readonly onReplace: () => void;
  readonly onVersions: () => void;
  readonly onRemove: () => void;
}): ReactNode {
  return (
    <div className="flex shrink-0 flex-wrap gap-1">
      {props.revoked ? null : (
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={props.verifying}
          onClick={props.onVerify}
          data-testid="secret-row-verify"
        >
          Verify
          <Spinner busy={props.verifying} />
        </Button>
      )}
      {props.revoked || !props.hasVersion ? null : (
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={props.onReplace}
          data-testid="secret-row-replace"
        >
          Replace value
        </Button>
      )}
      <Button
        type="button"
        size="sm"
        variant="ghost"
        aria-expanded={props.showVersions}
        onClick={props.onVersions}
        data-testid="secret-row-versions"
      >
        Versions
      </Button>
      {props.revoked ? null : (
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={props.removing}
          onClick={props.onRemove}
          data-testid="secret-row-remove"
        >
          Remove
        </Button>
      )}
      {props.details}
    </div>
  );
}

function SecretRowHistory(props: {
  readonly secret: EnvironmentSecret;
  readonly client: HostClient<HostRpcRegistry>;
  readonly hostId: string | null;
  readonly hostName: (hostId: string) => string;
  readonly onChanged: () => void;
  readonly replacements: number;
  readonly showVersions: boolean;
}): ReactNode {
  return (
    <>
      {props.replacements > 0 || props.showVersions ? (
        <SecretRotationStatus
          key={props.replacements}
          client={props.client}
          secretId={props.secret.secretId}
          hostName={props.hostName}
        />
      ) : null}
      {props.replacements > 0 ? (
        <p
          className="max-w-[72ch] text-ui-xs text-muted-foreground"
          data-testid="secret-restart-line"
        >
          {SECRET_RESTART_LINE}
        </p>
      ) : null}
      {props.showVersions ? (
        <div className="flex flex-col gap-3 pl-3">
          <SecretVersionsList
            secret={props.secret}
            client={props.client}
            hostId={props.hostId}
            onChanged={props.onChanged}
          />
          <RecoveryOrder />
        </div>
      ) : null}
    </>
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
  const [replacing, setReplacing] = useState(false);
  const [removing, setRemoving] = useState(false);
  // Each accepted replacement remounts the status, so it reads the new
  // rotation from the start and re-reads it until it settles.
  const [replacements, setReplacements] = useState(0);
  const [showVersions, setShowVersions] = useState(false);
  const actions = useSecretRowActions(props);
  const environmentId = useDetailsEnvironmentId(props.client);
  const removal = actions.versions.data?.removal ?? null;
  const revoked = secret.revoked || removal !== null;
  const versionLabel =
    actions.currentVersion === undefined
      ? "unknown"
      : String(actions.currentVersion.ordinal);
  const line = verifyFeedback(
    actions.verify.data,
    actions.verify.error,
    secret.protocol,
  );
  const removeError = removalFailure(actions.remove.data, actions.remove.error);
  const remove = (): void => {
    if (actions.currentVersionId === null) return;
    actions.remove.mutate(
      {
        secretId: secret.secretId,
        versionId: actions.currentVersionId,
        environmentId: actions.environmentId,
      },
      {
        onSuccess: (answer) => {
          if (answer.outcome !== "refused") setRemoving(false);
        },
      },
    );
  };
  // Terminal removals remain available in the header's retained metadata.
  if (removal?.outcome === "destroyed") return null;

  return (
    <li
      className="flex flex-col gap-1.5 border-b border-border/60 py-3 last:border-b-0"
      data-testid="secret-row"
      data-secret-name={secret.name}
    >
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <SecretRowIdentity secret={secret} revoked={revoked} />
        <SecretRowControls
          revoked={revoked}
          hasVersion={secret.currentVersionId !== null}
          verifying={actions.verify.isPending}
          removing={actions.remove.isPending}
          showVersions={showVersions}
          details={
            environmentId === null ? null : (
              <SettingsDetailsButton
                subject={{
                  environmentId,
                  kind: "secret",
                  key: secret.secretId,
                }}
                title={secret.name}
              />
            )
          }
          onVerify={() =>
            actions.verify.mutate({
              target: "secret",
              secretId: secret.secretId,
              environmentId: actions.environmentId,
            })
          }
          onReplace={() => setReplacing(true)}
          onVersions={() => setShowVersions((open) => !open)}
          onRemove={() => {
            actions.remove.reset();
            setRemoving(true);
          }}
        />
      </div>
      {revoked ? null : (
        <p className="max-w-[72ch] text-ui-xs text-muted-foreground">
          {SECRET_READABLE_WHERE}
        </p>
      )}
      {removal === null ? null : (
        <SecretRemovalStatus
          removal={removal}
          pending={actions.remove.isPending || actions.versions.isFetching}
          onRetry={() => {
            if (actions.currentVersionId === null)
              void actions.versions.refetch();
            else remove();
          }}
        />
      )}
      {removeError === null ? null : (
        <p role="alert" className="text-ui-xs text-warning-foreground">
          {removeError}
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
      <SecretRowHistory
        secret={secret}
        client={props.client}
        hostId={props.hostId}
        hostName={props.hostName}
        onChanged={props.onChanged}
        replacements={replacements}
        showVersions={showVersions}
      />
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
        isPending={actions.remove.isPending}
        blockedReason={removeBlockedReason(
          actions.versions.error,
          actions.versions.isFetching,
          actions.currentVersionId,
        )}
        onConfirm={remove}
      >
        {removeError === null ? null : (
          <p
            role="alert"
            className="px-5 pb-3 text-ui-xs text-warning-foreground"
          >
            {removeError}
          </p>
        )}
      </ConfirmDestructiveDialog>
    </li>
  );
}
