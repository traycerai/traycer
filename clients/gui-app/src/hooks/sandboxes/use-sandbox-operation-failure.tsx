import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import type {
  SandboxRowOperation,
  SandboxRowVerb,
} from "@/hooks/sandboxes/use-sandbox-operation";
import {
  ADD_CREDITS_LINK,
  sandboxCreditShortLine,
  DETAILS,
  RETRY,
  sandboxVerbFailureLine,
} from "@/lib/sandboxes/sandbox-strings";
import { SANDBOX_REFUSAL_CODE_INSUFFICIENT_CREDIT } from "@traycer/protocol/host/sandbox-control";
import { SandboxOperationError } from "@/hooks/sandboxes/sandbox-failure-copy";
import type { SandboxControlFailure } from "@traycer-clients/shared/host-client/sandbox-control";
import { useConfigurationBillingUrl } from "@/hooks/sandboxes/use-configuration-billing-url";
import { useOffersAddCredits } from "@/hooks/sandboxes/use-team-billing-admin";
import { useSandboxHostConfiguration } from "@/hooks/sandboxes/use-on-team-sandbox";
import { useOpenLink } from "@/lib/links/open-link";
import type { StageConfiguration } from "@/lib/sandboxes/sandbox-stage-model";
import { openSandboxDetails } from "@/stores/sandboxes/sandbox-details-store";

/** The same lasting outcome and remedies on every sandbox action surface. */
export interface SandboxOperationFailureProps {
  readonly sandboxId: string;
  readonly name: string;
  readonly hostId?: string;
  readonly configuration?: StageConfiguration;
  readonly operation: SandboxRowOperation | null;
  readonly busy: boolean;
  readonly onRetry: ((verb: SandboxRowVerb) => void) | null;
}

/** The refusal for want of credits a failed operation carries, else null. */
function creditRefusalOf(
  error: unknown,
): Extract<SandboxControlFailure, { kind: "refused" }> | null {
  const failure = error instanceof SandboxOperationError ? error.failure : null;
  return failure?.kind === "refused" &&
    failure.code === SANDBOX_REFUSAL_CODE_INSUFFICIENT_CREDIT &&
    failure.reason !== "unverified" &&
    failure.reason !== "unsupported-subscription"
    ? failure
    : null;
}

/** Capture runtime-dependent remedies before a receipt renders outside its provider. */
export function useSandboxOperationFailure(
  props: SandboxOperationFailureProps,
): ReactNode {
  const { operation, onRetry } = props;
  const hostConfiguration = useSandboxHostConfiguration(props.hostId ?? null);
  const configuration = props.configuration ??
    hostConfiguration ?? { kind: "personal" };
  const billingUrl = useConfigurationBillingUrl(configuration);
  const openLink = useOpenLink();
  const offersAddCredits = useOffersAddCredits(configuration);
  if (operation?.kind !== "failed") return null;
  const creditFailure = creditRefusalOf(operation.error);
  const message =
    creditFailure === null
      ? `${sandboxVerbFailureLine(operation.verb, props.name)}${safeFailureClause(operation.error)}`
      : `Couldn't ${operation.verb} ${props.name} · ${sandboxCreditShortLine(configuration, creditFailure.creditSource ?? null, creditFailure.shortfallMc, { waking: true, context: "clause" })}`;
  return (
    <div
      role="alert"
      className="flex w-full flex-wrap items-baseline gap-2 text-ui-xs"
    >
      <span className="text-destructive">{message}</span>
      <span className="text-muted-foreground">
        {`Support reference: ${operation.reference}`}
      </span>
      {creditFailure === null || !offersAddCredits ? null : (
        <Button
          type="button"
          variant="link"
          size="inline-xs"
          onClick={() => void openLink(billingUrl, "account", null)}
        >
          {ADD_CREDITS_LINK}
        </Button>
      )}
      {onRetry === null ? null : (
        <Button
          type="button"
          variant="link"
          size="inline-xs"
          disabled={props.busy}
          onClick={() => onRetry(operation.verb)}
        >
          {RETRY}
        </Button>
      )}
      <Button
        type="button"
        variant="link"
        size="inline-xs"
        onClick={() => openSandboxDetails(props.sandboxId)}
      >
        {DETAILS}
      </Button>
    </div>
  );
}

/** Only translated control failures are safe to show inline. */
function safeFailureClause(error: Error): string {
  return error instanceof SandboxOperationError ? `. ${error.message}` : "";
}
