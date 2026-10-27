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
import { useConfigurationBillingUrl } from "@/hooks/sandboxes/use-configuration-billing-url";
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
  readonly onRetry: (verb: SandboxRowVerb) => void;
}

/** Capture runtime-dependent remedies before a receipt renders outside its provider. */
export function useSandboxOperationFailure(
  props: SandboxOperationFailureProps,
): ReactNode {
  const { operation } = props;
  const hostConfiguration = useSandboxHostConfiguration(props.hostId ?? null);
  const configuration = props.configuration ??
    hostConfiguration ?? { kind: "personal" };
  const billingUrl = useConfigurationBillingUrl(configuration);
  const openLink = useOpenLink();
  if (operation?.kind !== "failed") return null;
  const failure =
    operation.error instanceof SandboxOperationError
      ? operation.error.failure
      : null;
  const creditFailure =
    failure?.kind === "refused" &&
    failure.code === SANDBOX_REFUSAL_CODE_INSUFFICIENT_CREDIT &&
    failure.reason !== "unverified" &&
    failure.reason !== "unsupported-subscription"
      ? failure
      : null;
  const message =
    creditFailure === null
      ? sandboxVerbFailureLine(operation.verb, props.name, operation.reference)
      : `Couldn't ${operation.verb} ${props.name} · ${sandboxCreditShortLine(configuration, creditFailure.creditSource ?? null, creditFailure.shortfallMc, true)}`;
  return (
    <div
      role="alert"
      className="flex w-full flex-wrap items-baseline gap-2 text-ui-xs"
    >
      <span className="text-destructive">{message}</span>
      {creditFailure === null ? null : (
        <Button
          type="button"
          variant="link"
          size="inline-xs"
          onClick={() => void openLink(billingUrl, "account", null)}
        >
          {ADD_CREDITS_LINK}
        </Button>
      )}
      <Button
        type="button"
        variant="link"
        size="inline-xs"
        disabled={props.busy}
        onClick={() => props.onRetry(operation.verb)}
      >
        {RETRY}
      </Button>
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
