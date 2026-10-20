import { useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type {
  EnvironmentSecret,
  SecretVersion,
} from "@traycer/protocol/host/environment-schemas";
import { Button } from "@/components/ui/button";
import { ConfirmDestructiveDialog } from "@/components/ui/confirm-destructive-dialog";
import { useHostQuery } from "@/hooks/host/use-host-query";
import { ignoreError } from "@/lib/browser-view/ignore-error";
import type { HostRpcRegistry } from "@/lib/host";
import { hostQueryKeys } from "@/lib/query-keys";
import { secretChangeRefusalLine } from "@/lib/sandboxes/secret-change-refusal-copy";
import { SECRET_SCOPE_LINE } from "@/lib/sandboxes/secrets-page-copy";

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

function errorText(error: unknown): string {
  return error instanceof Error && error.message.length > 0
    ? error.message
    : "That didn't go through.";
}

function VersionRow(props: {
  readonly version: SecretVersion;
  readonly secret: EnvironmentSecret;
  readonly client: HostClient<HostRpcRegistry>;
  readonly onChanged: () => void;
}): ReactNode {
  const { version, secret } = props;
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [confirmingDestroy, setConfirmingDestroy] = useState(false);
  const destroyed = version.destroyedAt !== null;

  const run = async (operation: "undo" | "destroy"): Promise<void> => {
    setBusy(true);
    setNote(null);
    try {
      if (operation === "undo") {
        const answer = await props.client.request("environment.secrets.undo", {
          secretId: secret.secretId,
          versionId: version.versionId,
          regrant: secret.revoked,
        });
        if (answer.outcome === "refused") {
          setNote(refusalText("undo", answer.code));
          return;
        }
      } else {
        const answer = await props.client.request(
          "environment.secrets.destroy",
          { secretId: secret.secretId, versionId: version.versionId },
        );
        if (answer.outcome === "refused") {
          setNote(refusalText("destroy", answer.code));
          return;
        }
      }
      props.onChanged();
    } catch (error) {
      setNote(errorText(error));
    } finally {
      setBusy(false);
    }
  };

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
                onClick={() => void run("undo")}
                data-testid="secret-version-undo"
              >
                {secret.revoked ? "Restore" : "Undo"}
              </Button>
            )}
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => setConfirmingDestroy(true)}
              data-testid="secret-version-destroy"
            >
              Destroy
            </Button>
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
          setConfirmingDestroy(false);
          void run("destroy");
        }}
      />
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
  const queryClient = useQueryClient();
  const versions = useHostQuery<
    HostRpcRegistry,
    "environment.secrets.versions"
  >({
    cacheKeyIdentity: undefined,
    client: props.client,
    method: "environment.secrets.versions",
    params: { secretId: props.secret.secretId },
    options: { enabled: true },
  });
  const reread = (): void => {
    void queryClient
      .invalidateQueries({
        queryKey: hostQueryKeys.methodScope(
          props.hostId,
          "environment.secrets.versions",
        ),
      })
      .catch(ignoreError);
    props.onChanged();
  };
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
            onChanged={reread}
          />
        ))}
      </ul>
      <p className="max-w-[72ch] text-ui-xs text-muted-foreground">
        {SECRET_SCOPE_LINE}
      </p>
    </div>
  );
}
