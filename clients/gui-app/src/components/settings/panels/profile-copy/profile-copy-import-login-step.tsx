import { useCallback, type ReactNode } from "react";
import { MutedAgentSpinner } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import { useOpenLink } from "@/lib/links/open-link";
import type { ProfileCopyLoginChallenge } from "@/lib/profile-copy/profile-copy-model";
import type { ProfileCopyNames } from "@/lib/profile-copy/profile-copy-presentation";
import {
  WaitingStepDeviceCode,
  WaitingStepUrlActions,
} from "../add-provider-profile-dialog";
import { CodePasteField } from "../code-paste-field";
import type { ProfileImportLoginFlow } from "./use-profile-import-login-flow";

function challengeGuidance(
  challenge: ProfileCopyLoginChallenge | null,
  names: ProfileCopyNames,
  destinationIsLocal: boolean,
): string {
  if (challenge === null) {
    return `Waiting for the sign-in on ${names.destination} to finish.`;
  }
  switch (challenge.kind) {
    case "code-paste":
      return `Open ${names.provider}'s sign-in page, approve, then paste the code it shows here.`;
    case "device-code":
      return "Open the page, enter this code, then come back here. Traycer continues on its own after you approve.";
    case "destination-local-browser":
      return destinationIsLocal
        ? "Finish in the browser that opens on this device."
        : `Finish signing in in Traycer on ${names.destination}. The sign-in page can only open there.`;
  }
}

/**
 * The live import sign-in for one destination. The destination is named in
 * the title: a person signing in here must know WHICH machine they are
 * authorizing. Nothing opens by itself - every page opens on a click - and a
 * destination-local page is offered only when that destination is this
 * machine; otherwise its address is never shown here.
 */
export function ProfileCopyImportLoginStep(props: {
  readonly login: ProfileImportLoginFlow;
  readonly names: ProfileCopyNames;
  readonly destinationIsLocal: boolean;
  readonly disabled: boolean;
  readonly onCancel: () => void;
}): ReactNode {
  const { login, names, destinationIsLocal } = props;
  const openLink = useOpenLink();
  const onOpenExternalLink = useCallback(
    (url: string) => {
      void openLink(url, "auth", null);
    },
    [openLink],
  );
  if (login.phase.kind === "idle") return null;
  if (login.phase.kind === "starting") {
    return (
      <div
        className="flex items-center gap-2 text-ui-xs text-muted-foreground"
        aria-live="polite"
      >
        <MutedAgentSpinner />
        Starting sign-in on {names.destination}…
      </div>
    );
  }

  const challenge = login.phase.challenge;
  const processingCode = login.codePaste.phase !== "idle";
  const pageUrl =
    challenge === null ||
    (challenge.kind === "destination-local-browser" && !destinationIsLocal)
      ? null
      : challenge.url;
  const userCode =
    challenge?.kind === "device-code" ? challenge.userCode : null;
  const guidance =
    login.codePaste.phase === "verifying"
      ? "Checking approval…"
      : challengeGuidance(challenge, names, destinationIsLocal);

  return (
    <div
      className="flex flex-col gap-3 rounded-md border border-info/30 bg-info/5 p-3"
      aria-live="polite"
    >
      <div className="flex items-start gap-2.5">
        <MutedAgentSpinner />
        <div className="min-w-0">
          <div className="text-ui-sm font-medium text-foreground">
            Signing in to {names.provider} on {names.destination}
          </div>
          <p className="mt-0.5 text-ui-xs leading-relaxed text-muted-foreground">
            {guidance}
          </p>
        </div>
      </div>
      <WaitingStepDeviceCode
        processingCode={processingCode}
        userCode={userCode}
      />
      <WaitingStepUrlActions
        processingCode={processingCode}
        loginUrl={pageUrl}
        autoOpen={false}
        onOpenExternalLink={onOpenExternalLink}
      />
      {login.codePaste.enabled ? (
        <CodePasteField
          key={login.codePaste.attemptId}
          codePaste={login.codePaste}
          disabled={login.cancelPending || props.disabled}
          visibleLabel
        />
      ) : null}
      <p className="text-ui-xs text-muted-foreground">
        Closing this window leaves the sign-in running on {names.destination}{" "}
        until it times out.
      </p>
      <div className="flex justify-end">
        <Button
          type="button"
          size="sm"
          variant="destructive"
          disabled={login.cancelPending || props.disabled}
          onClick={props.onCancel}
        >
          {login.cancelPending ? <MutedAgentSpinner /> : null}
          Cancel copy to {names.destination}
        </Button>
      </div>
    </div>
  );
}
