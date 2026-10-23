import { useRef, useState, type ReactNode } from "react";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { EnvironmentSecret } from "@traycer/protocol/host/environment-schemas";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { HostRpcRegistry } from "@/lib/host";
import { useConfigurationEnvironmentId } from "@/components/settings/environment/configuration-source";
import { cloudVerdictPreflight } from "@/lib/host/cloud-verdict-preflight";
import { replaceOutcome } from "@/lib/sandboxes/secret-replace-outcome";
import {
  SECRET_CUSTODY_SENTENCE,
  SECRET_RESTART_LINE,
  SECRET_SCOPE_LINE,
} from "@/lib/sandboxes/secrets-page-copy";

/**
 * Replace value: a rotation, compare-and-set on the version the list showed
 * when the dialog opened. The typed value lives in this component only, is
 * sent by a direct request, and is dropped when the dialog closes.
 */
export function ReplaceSecretValueDialog(props: {
  readonly open: boolean;
  readonly secret: EnvironmentSecret;
  readonly client: HostClient<HostRpcRegistry>;
  readonly onOpenChange: (open: boolean) => void;
  /** Accepted: the row shows the rotation and re-reads the list. */
  readonly onReplaced: () => void;
  /** Changed elsewhere: the list is re-read before another try. */
  readonly onStale: () => void;
}): ReactNode {
  const environmentId = useConfigurationEnvironmentId();
  const { secret } = props;
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  // Which open of the dialog a replace belongs to: one that settles after a
  // close (the person cancelled and opened it again) leaves the form now
  // showing alone.
  const openGeneration = useRef(0);
  // The compare-and-set token: the version the list showed when this open
  // began. A re-read under an open dialog (another admin's rotation) must not
  // become the token, or Replace would overwrite that rotation instead of
  // coming back stale. After a stale answer the next version the list shows
  // is taken: the person has just been told the value changed.
  const [held, setHeld] = useState<{
    readonly open: boolean;
    readonly versionId: string | null;
    readonly adoptNext: boolean;
  }>(() => ({
    open: props.open,
    versionId: secret.currentVersionId,
    adoptNext: false,
  }));
  if (held.open !== props.open) {
    setHeld({
      open: props.open,
      versionId: secret.currentVersionId,
      adoptNext: false,
    });
  } else if (held.adoptNext && secret.currentVersionId !== held.versionId) {
    setHeld({
      open: held.open,
      versionId: secret.currentVersionId,
      adoptNext: false,
    });
  }
  const expectedVersionId = held.versionId;

  const close = (open: boolean): void => {
    if (open) return;
    openGeneration.current += 1;
    setValue("");
    setNote(null);
    setBusy(false);
    props.onOpenChange(false);
  };

  const replace = async (): Promise<void> => {
    if (expectedVersionId === null) return;
    const sentFrom = openGeneration.current;
    setBusy(true);
    setNote(null);
    try {
      const method = "environment.secrets.replaceValue";
      const request = {
        secretId: secret.secretId,
        value,
        expectedVersionId,
        environmentId,
      };
      if (environmentId !== null) cloudVerdictPreflight(method)();
      const answer =
        environmentId === null
          ? await props.client.request(method, request)
          : await props.client.requestWithSignalRequiringHostMethodVersion(
              method,
              { ...request, environmentId },
              undefined,
              { method, version: { major: 1, minor: 1 } },
            );

      const outcome = replaceOutcome(answer);
      // The row and the list follow the server whichever open is showing.
      if (outcome.kind === "accepted") props.onReplaced();
      else if (outcome.reread) props.onStale();
      if (openGeneration.current !== sentFrom) return;
      if (outcome.kind === "accepted") {
        close(false);
        return;
      }
      if (outcome.reread) {
        setHeld((current) => ({ ...current, adoptNext: true }));
      }
      setNote(outcome.text);
    } catch (error) {
      if (openGeneration.current !== sentFrom) return;
      setNote(
        error instanceof Error && error.message.length > 0
          ? error.message
          : "Couldn't replace the value.",
      );
    } finally {
      if (openGeneration.current === sentFrom) setBusy(false);
    }
  };

  return (
    <Dialog open={props.open} onOpenChange={close}>
      <DialogContent
        className="w-[min(92vw,28rem)] sm:max-w-none"
        data-testid="replace-secret-dialog"
      >
        <DialogHeader className="gap-1.5">
          <DialogTitle>Replace {secret.name}</DialogTitle>
          <DialogDescription>{SECRET_SCOPE_LINE}</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-1.5 px-5">
          <p
            className="max-w-[72ch] text-ui-xs text-muted-foreground"
            data-testid="secret-replace-custody"
          >
            {SECRET_CUSTODY_SENTENCE}
          </p>
          <p
            className="max-w-[72ch] text-ui-xs text-muted-foreground"
            data-testid="secret-replace-restart"
          >
            {SECRET_RESTART_LINE}
          </p>
          <Label htmlFor="replace-secret-value">New value</Label>
          <Input
            id="replace-secret-value"
            type="password"
            autoComplete="new-password"
            spellCheck={false}
            value={value}
            onChange={(event) => setValue(event.currentTarget.value)}
            data-testid="replace-secret-value"
          />
          {note === null ? null : (
            <p
              role="status"
              className="max-w-[72ch] text-ui-xs text-warning-foreground"
              data-testid="replace-secret-note"
            >
              {note}
            </p>
          )}
        </div>
        <DialogFooter>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => close(false)}
          >
            Cancel
          </Button>
          <Button
            type="button"
            size="sm"
            variant="secondary"
            disabled={busy || value.length === 0 || expectedVersionId === null}
            onClick={() => void replace()}
            data-testid="replace-secret-confirm"
          >
            Replace
            {busy ? (
              <AgentSpinningDots
                className={undefined}
                testId={undefined}
                variant={undefined}
                tone="muted"
              />
            ) : null}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
