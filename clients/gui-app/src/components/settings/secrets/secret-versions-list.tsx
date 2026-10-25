import { useState, type ReactNode } from "react";
import type { ResponseOfMethod } from "@traycer-clients/shared/host-transport/host-messenger";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type {
  EnvironmentSecret,
  SecretVersion,
} from "@traycer/protocol/host/environment-schemas";
import { Button } from "@/components/ui/button";
import { ConfirmDestructiveDialog } from "@/components/ui/confirm-destructive-dialog";
import { useHostQuery } from "@/hooks/host/use-host-query";
import { useAddressedEnvironment } from "@/hooks/environment/use-addressed-environment";
import { useSecretVersionActions } from "@/components/settings/secrets/use-secret-version-actions";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import type { HostRpcRegistry } from "@/lib/host";
import { secretChangeRefusalLine } from "@/lib/sandboxes/secret-change-refusal-copy";
import { HostMethodVersionUnsatisfiedError } from "@traycer-clients/shared/host-transport/host-messenger";
import {
  SECRET_SCOPE_LINE,
  SECRETS_NEED_UPDATED_HOST,
} from "@/lib/sandboxes/secrets-page-copy";

/**
 * A secret's versions: each with when it was made,
 * whether it is current, superseded or destroyed, and Undo (a rotation back
 * to it) and Destroy (its value erased). Never a value. Undo on a revoked
 * secret restores it with the grants a new secret gets (`regrant: true`),
 * never the revoked ones. A refusal reads its line.
 */

const DATE_FORMAT = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

function versionState(version: SecretVersion): string {
  if (version.destroyedAt !== null) return "destroyed";
  if (version.current) return "current";
  return "replaced";
}

function refusalText(operation: "undo" | "destroy", code: string): string {
  return secretChangeRefusalLine(operation, code) ?? "That didn't go through.";
}

/** A failed Undo or Destroy: an old host by name, else the host's words. */
function errorNote(error: Error | null): string | null {
  if (error === null) return null;
  return error instanceof HostMethodVersionUnsatisfiedError
    ? SECRETS_NEED_UPDATED_HOST
    : error.message;
}

function versionActionNote(
  undo:
    | ResponseOfMethod<HostRpcRegistry, "environment.secrets.undo">
    | undefined,
  destroy:
    | ResponseOfMethod<HostRpcRegistry, "environment.secrets.destroy">
    | undefined,
): string | null {
  if (undo?.outcome === "refused") return refusalText("undo", undo.code);
  if (destroy?.outcome === "refused")
    return refusalText("destroy", destroy.code);
  return null;
}

function VersionRow(props: {
  readonly version: SecretVersion;
  readonly secret: EnvironmentSecret;
  readonly client: HostClient<HostRpcRegistry>;
  readonly hostId: string | null;
  readonly onChanged: () => void;
}): ReactNode {
  const { version, secret } = props;
  const [confirmingDestroy, setConfirmingDestroy] = useState(false);
  const destroyed = version.destroyedAt !== null;

  const { environmentId, undo, destroy } = useSecretVersionActions(props);
  const busy = undo.isPending || destroy.isPending;
  const note =
    errorNote(undo.error) ??
    errorNote(destroy.error) ??
    versionActionNote(undo.data, destroy.data);

  return (
    <li
      className="flex flex-col gap-1 py-1.5"
      data-testid="secret-version"
      data-version-state={versionState(version)}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-ui-xs text-foreground">
          Version {version.ordinal} · {DATE_FORMAT.format(version.createdAt)}
          <span className="text-muted-foreground">
            {" · "}
            {versionState(version)}
          </span>
        </span>
        {destroyed ? null : (
          <span className="flex shrink-0 gap-1">
            {version.current ? null : (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => {
                  destroy.reset();
                  undo.mutate({
                    secretId: secret.secretId,
                    versionId: version.versionId,
                    regrant: secret.revoked,
                    environmentId,
                  });
                }}
                data-testid="secret-version-undo"
              >
                {secret.revoked ? "Restore" : "Undo"}
                {undo.isPending ? (
                  <AgentSpinningDots
                    className={undefined}
                    testId={undefined}
                    variant={undefined}
                    tone="muted"
                  />
                ) : null}
              </Button>
            )}
            {version.current ? null : (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => {
                  undo.reset();
                  destroy.reset();
                  setConfirmingDestroy(true);
                }}
                data-testid="secret-version-destroy"
              >
                Destroy
              </Button>
            )}
          </span>
        )}
      </div>
      {note === null ? null : (
        <p
          role="status"
          className="max-w-[72ch] text-ui-xs text-warning-foreground"
          data-testid="secret-version-note"
        >
          {note}
        </p>
      )}
      <ConfirmDestructiveDialog
        open={confirmingDestroy}
        onOpenChange={setConfirmingDestroy}
        title={`Destroy version ${version.ordinal} of ${secret.name}?`}
        description={`Its value is erased now and can't be restored. ${SECRET_SCOPE_LINE}`}
        cascadeSummary={null}
        actionLabel="Destroy"
        isPending={busy}
        blockedReason={null}
        onConfirm={() => {
          destroy.mutate(
            {
              secretId: secret.secretId,
              versionId: version.versionId,
              environmentId,
            },
            {
              onSuccess: (answer) => {
                if (answer.outcome !== "refused") setConfirmingDestroy(false);
              },
            },
          );
        }}
      >
        {note === null ? null : (
          <p
            role="alert"
            className="px-5 pb-3 text-ui-xs text-warning-foreground"
          >
            {note}
          </p>
        )}
      </ConfirmDestructiveDialog>
    </li>
  );
}

export function SecretVersionsList(props: {
  readonly secret: EnvironmentSecret;
  readonly client: HostClient<HostRpcRegistry>;
  readonly hostId: string | null;
  /** Undo made another version current: the list's row re-reads too. */
  readonly onChanged: () => void;
}): ReactNode {
  const { environmentId, resolved } = useAddressedEnvironment();
  const versions = useHostQuery<
    HostRpcRegistry,
    "environment.secrets.versions"
  >({
    cacheKeyIdentity: undefined,
    client: props.client,
    method: "environment.secrets.versions",
    params: { secretId: props.secret.secretId, environmentId },
    requiredHostMethodVersion: () =>
      environmentId === null
        ? null
        : {
            method: "environment.secrets.versions",
            version: { major: 1, minor: 1 },
          },
    options: { enabled: resolved },
  });
  if (versions.isError) {
    return (
      <p
        className="text-ui-xs text-warning-foreground"
        data-testid="secret-versions-error"
      >
        {versions.error.message}
      </p>
    );
  }
  const list = versions.data?.versions ?? null;
  if (list === null) return null;
  return (
    <div className="flex flex-col gap-1" data-testid="secret-versions">
      <ul className="flex flex-col">
        {list.map((version) => (
          <VersionRow
            key={version.versionId}
            version={version}
            secret={props.secret}
            client={props.client}
            hostId={props.hostId}
            onChanged={props.onChanged}
          />
        ))}
      </ul>
      <p className="max-w-[72ch] text-ui-xs text-muted-foreground">
        {SECRET_SCOPE_LINE}
      </p>
    </div>
  );
}
