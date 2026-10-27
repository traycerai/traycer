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
import { useSecretRemovalRetry } from "@/components/settings/details/use-secret-removal-retry";
import { useSecretRowActions } from "@/components/settings/secrets/use-secret-row-actions";
import { removalWithFailures } from "@/components/settings/secrets/secret-removal-lines";
import { SecretRemovalStatus } from "@/components/settings/secrets/secret-removal-status";
import { SettingsDetailsButton } from "@/components/settings/details/settings-details-button";
import { useDetailsEnvironmentId } from "@/components/settings/details/use-details-environment-id";
import { secretChangeRefusalLine } from "@/lib/sandboxes/secret-change-refusal-copy";
import type { HostRpcRegistry } from "@/lib/host";
import {
  secretVerifyLine,
  type SecretVerifyLine,
} from "@/lib/sandboxes/secret-verify-copy";
import {
  SECRET_PENDING_REVIEW_LABEL,
  SECRET_RECOVERY_FALLBACK,
  SECRET_RECOVERY_STEPS,
  SECRET_RECOVERY_TITLE,
  SECRET_RESTART_LINE,
  SECRET_REVOKED_LABEL,
  SECRETS_NEED_UPDATED_HOST,
  secretAddedClause,
  secretRemovePreview,
  secretUsedByLine,
  secretRowDetail,
  secretValueOrigin,
} from "@/lib/sandboxes/secrets-page-copy";
import { useConfigurationSource } from "@/components/settings/environment/configuration-source";
import { useHostsRunningPersonal } from "@/components/settings/environment/use-hosts-running-configuration";
import { useSecretMcpServerNames } from "@/hooks/environment/team/use-mcp-servers";
import { navigateToSettingsSection } from "@/lib/settings-navigation";
import { useEnvironmentPick } from "@/stores/settings/settings-environment-pick-store";
import { cn } from "@/lib/utils";

const VERIFY_TONE: Readonly<Record<SecretVerifyLine["tone"], string>> = {
  success: "text-success-foreground",
  warning: "text-warning-foreground",
};

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
  readonly origin: string | null;
}): ReactNode {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <span className="flex flex-wrap items-center gap-2">
        <span
          className="min-w-0 text-ui-sm text-muted-foreground"
          data-testid="secret-row-line"
        >
          <span className="font-mono text-foreground">{props.secret.name}</span>
          {` · ${secretRowDetail({
            destinations: props.secret.destinations,
            origin: props.origin,
          })}`}
        </span>
        {props.revoked ? (
          <Badge variant="outline">{SECRET_REVOKED_LABEL}</Badge>
        ) : null}
        {!props.revoked && props.secret.state === "pending_review" ? (
          <Badge variant="outline">{SECRET_PENDING_REVIEW_LABEL}</Badge>
        ) : null}
      </span>
    </div>
  );
}

function SecretRowControls(props: {
  readonly revoked: boolean;
  readonly hasVersion: boolean;
  readonly removing: boolean;
  readonly details: ReactNode;
  readonly onReplace: () => void;
  readonly onRemove: () => void;
}): ReactNode {
  return (
    <div className="flex shrink-0 flex-wrap gap-1">
      {props.revoked || !props.hasVersion ? null : (
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={props.onReplace}
          data-testid="secret-row-replace"
        >
          Replace
        </Button>
      )}
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

/** A replacement's progress, on the row until it settles. */
function SecretRowReplacement(props: {
  readonly secretId: string;
  readonly client: HostClient<HostRpcRegistry>;
  readonly hostName: (hostId: string) => string;
  readonly replacements: number;
}): ReactNode {
  if (props.replacements === 0) return null;
  return (
    <>
      <SecretRotationStatus
        key={props.replacements}
        client={props.client}
        secretId={props.secretId}
        hostName={props.hostName}
      />
      <p
        className="max-w-[72ch] text-ui-xs text-muted-foreground"
        data-testid="secret-restart-line"
      >
        {SECRET_RESTART_LINE}
      </p>
    </>
  );
}

/**
 * What a secret's Details holds besides its status: Verify, the current
 * rotation, the versions with Undo and Destroy, and the recovery order.
 */
function SecretDetailsControls(props: {
  readonly secret: EnvironmentSecret;
  readonly client: HostClient<HostRpcRegistry>;
  readonly hostId: string | null;
  readonly hostName: (hostId: string) => string;
  readonly onChanged: () => void;
  readonly revoked: boolean;
  readonly verifying: boolean;
  readonly verifyLine: SecretVerifyLine | null;
  readonly onVerify: () => void;
}): ReactNode {
  return (
    <div
      className="flex flex-col gap-3 py-3"
      data-testid="secret-details-controls"
    >
      {props.revoked ? null : (
        <div className="flex flex-col items-start gap-1">
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={props.verifying}
            onClick={props.onVerify}
            data-testid="secret-row-verify"
          >
            Verify
            <Spinner busy={props.verifying} />
          </Button>
          {props.verifyLine === null ? null : (
            <p
              role="status"
              className={cn(
                "max-w-[72ch] text-ui-xs",
                VERIFY_TONE[props.verifyLine.tone],
              )}
              data-testid="secret-verify-line"
            >
              {props.verifyLine.text}
            </p>
          )}
        </div>
      )}
      <SecretRotationStatus
        client={props.client}
        secretId={props.secret.secretId}
        hostName={props.hostName}
      />
      <SecretVersionsList
        secret={props.secret}
        client={props.client}
        hostId={props.hostId}
        onChanged={props.onChanged}
      />
      <RecoveryOrder />
    </div>
  );
}

/**
 * One secret on Settings ▸ Personal ▸ Secrets: "STRIPE_KEY · Set · sent to
 * api.stripe.com · added by you 24 Oct" with Replace, Remove and Details.
 * Details holds Verify, the versions and the recovery order; a replacement's
 * progress stays on the row. No value is ever here. Verify and the versions
 * act on the secret by id, so they work for every kind, those already stored
 * included. A held secret's pending-review badge stays.
 */
type SecretVersionsAnswer = ResponseOfMethod<
  HostRpcRegistry,
  "environment.secrets.versions"
>;
type SecretVersion = SecretVersionsAnswer["versions"][number];

/** What a row reads from its secret's versions, before they have answered too. */
function secretRowVersions(answer: SecretVersionsAnswer | undefined): {
  readonly current: SecretVersion | undefined;
  readonly first: SecretVersion | undefined;
  readonly removal: SecretVersionsAnswer["removal"] | null;
} {
  const versions = answer?.versions ?? [];
  return {
    current: versions.find((version) => version.current),
    first: versions.find((version) => version.ordinal === 1),
    removal: answer?.removal ?? null,
  };
}

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
  const actions = useSecretRowActions({ ...props, removing: secret.revoked });
  const environmentId = useDetailsEnvironmentId(props.client);
  const retry = useSecretRemovalRetry(props.client, props.hostId);
  const source = useConfigurationSource();
  // Personal's values, and a computer's own, are all the person's; a team's
  // author is not on the wire.
  const byYou = source.kind === "host" || source.configuration === "personal";
  // The computers running Personal hold a copy of Personal's; a team's
  // computers and every sandbox use the value without one.
  const onPersonal = useEnvironmentPick().kind === "personal";
  const running = useHostsRunningPersonal();
  const holders = onPersonal
    ? running.hosts.filter((host) => host.kind === "personal")
    : [];
  const usedBy = secretUsedByLine(
    useSecretMcpServerNames(secret.secretId, removing),
  );
  const { current, first, removal } = secretRowVersions(actions.versions.data);
  const revoked = secret.revoked || removal !== null;
  const line = verifyFeedback(
    actions.verify.data,
    actions.verify.error,
    secret.protocol,
  );
  const removeError =
    retry.error ?? removalFailure(actions.remove.data, actions.remove.error);
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
        <SecretRowIdentity
          secret={secret}
          revoked={revoked}
          origin={
            current === undefined ? null : secretValueOrigin(current, byYou)
          }
        />
        <SecretRowControls
          revoked={revoked}
          hasVersion={secret.currentVersionId !== null}
          removing={actions.remove.isPending}
          // Verify, Versions, Undo and Destroy need no environment id: only
          // the diagnostics wait for it.
          details={
            <SettingsDetailsButton
              subject={
                environmentId === null
                  ? null
                  : { environmentId, kind: "secret", key: secret.secretId }
              }
              title={secret.name}
              controls={
                <SecretDetailsControls
                  secret={secret}
                  client={props.client}
                  hostId={props.hostId}
                  hostName={props.hostName}
                  onChanged={props.onChanged}
                  revoked={revoked}
                  verifying={actions.verify.isPending}
                  verifyLine={line}
                  onVerify={() =>
                    actions.verify.mutate({
                      target: "secret",
                      secretId: secret.secretId,
                      environmentId: actions.environmentId,
                    })
                  }
                />
              }
            />
          }
          onReplace={() => setReplacing(true)}
          onRemove={() => {
            actions.remove.reset();
            setRemoving(true);
          }}
        />
      </div>
      {removal === null ? null : (
        <SecretRemovalStatus
          removal={removalWithFailures(removal, null)}
          hostName={props.hostName}
          pending={
            retry.pending ||
            actions.remove.isPending ||
            actions.versions.isFetching ||
            environmentId === null
          }
          onRetry={() => {
            if (environmentId === null) return;
            retry.onRetry({
              environmentId,
              kind: "secret",
              key: secret.secretId,
            });
          }}
        />
      )}
      {removeError === null ? null : (
        <p role="alert" className="text-ui-xs text-warning-foreground">
          {removeError}
        </p>
      )}
      <SecretRowReplacement
        secretId={secret.secretId}
        client={props.client}
        hostName={props.hostName}
        replacements={replacements}
      />
      <ReplaceSecretValueDialog
        open={replacing}
        secret={secret}
        client={props.client}
        onOpenChange={setReplacing}
        onReplaced={() => setReplacements((count) => count + 1)}
      />
      <ConfirmDestructiveDialog
        open={removing}
        onOpenChange={setRemoving}
        title={`Remove ${secret.name}?`}
        description={
          <>
            {usedBy === null ? null : (
              <span className="block" data-testid="secret-remove-used-by">
                {usedBy.before}
                <Button
                  type="button"
                  variant="link"
                  size="inline-xs"
                  onClick={() => {
                    setRemoving(false);
                    navigateToSettingsSection("mcp-servers");
                  }}
                >
                  {usedBy.link}
                </Button>
                {usedBy.after}
              </span>
            )}
            {secretRemovePreview({
              added:
                first === undefined
                  ? null
                  : secretAddedClause(first.createdAt, byYou),
              version: current === undefined ? null : current.ordinal,
              computers: holders.map((host) => host.name),
            })}
          </>
        }
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
