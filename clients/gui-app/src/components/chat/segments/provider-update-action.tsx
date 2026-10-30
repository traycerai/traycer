import { PROVIDER_OUTDATED_ERROR_CODE } from "@traycer/protocol/host/agent/gui/agent-runtime";
import type { GuiHarnessId } from "@traycer/protocol/host/index";
import { useMaybeChatTranscript } from "@/components/chat/chat-transcript-context";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import { useHostClientForHostId } from "@/hooks/host/use-host-client-for-host-id";
import { useProviderUpdateForClient } from "@/hooks/providers/use-provider-update";

/**
 * Update beside the error row of a turn the provider refused because its
 * command-line tool is out of date, on the host that ran the turn. The host
 * gives the row this code only where it can update the provider; any other
 * code, a row with no harness, or a host with no update method gets nothing.
 * Retry stays the row's own.
 *
 * Split in two for the reason `FallbackManualRungActions` is: the error row
 * renders without a transcript in some surfaces, and the host hooks below
 * throw outside a host runtime, so the transcript gate comes first.
 */
export function ProviderUpdateAction({
  code,
  harnessId,
}: {
  readonly code: string | null;
  readonly harnessId: GuiHarnessId | null;
}) {
  const transcript = useMaybeChatTranscript();
  if (
    code !== PROVIDER_OUTDATED_ERROR_CODE ||
    harnessId === null ||
    transcript === null
  ) {
    return null;
  }
  return (
    <ProviderUpdateButton harnessId={harnessId} hostId={transcript.hostId} />
  );
}

function ProviderUpdateButton({
  harnessId,
  hostId,
}: {
  readonly harnessId: GuiHarnessId;
  readonly hostId: string;
}) {
  const client = useHostClientForHostId(hostId);
  const { update, pending } = useProviderUpdateForClient(client, hostId);
  if (update === null) return null;
  return (
    <div className="mt-1 flex">
      <Button
        size="sm"
        variant="secondary"
        disabled={pending}
        onClick={() => update(harnessId)}
      >
        Update
        {pending ? (
          <AgentSpinningDots
            className={undefined}
            testId={undefined}
            variant={undefined}
          />
        ) : null}
      </Button>
    </div>
  );
}
