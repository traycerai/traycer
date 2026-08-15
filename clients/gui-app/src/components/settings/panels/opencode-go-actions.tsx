import { use, type ReactNode } from "react";
import { MutedAgentSpinner } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import { useRunnerOpenExternalLink } from "@/hooks/runner/use-open-external-link-mutation";
import { RunnerHostContext } from "@/providers/runner-host-context";

const OPENCODE_GO_MANAGE_URL = "https://opencode.ai/auth";

export function OpenModelProvidersButton({
  onClick,
}: {
  readonly onClick: () => void;
}): ReactNode {
  return (
    <Button
      type="button"
      variant="link"
      size="xs"
      className="h-auto p-0"
      onClick={onClick}
    >
      Open Model Providers
    </Button>
  );
}

export function OpenCodeGoManageLink(): ReactNode {
  const runnerHost = use(RunnerHostContext);
  const openExternalLink = useRunnerOpenExternalLink();
  const isPending = openExternalLink.isPending;
  if (runnerHost !== null) {
    return (
      <Button
        type="button"
        variant="link"
        size="xs"
        className="h-auto w-fit p-0"
        disabled={isPending}
        onClick={() => openExternalLink.mutate(OPENCODE_GO_MANAGE_URL)}
      >
        {isPending ? <MutedAgentSpinner /> : null}
        Manage Go
      </Button>
    );
  }
  return (
    <Button asChild variant="link" size="xs" className="h-auto w-fit p-0">
      <a href={OPENCODE_GO_MANAGE_URL} target="_blank" rel="noreferrer">
        Manage Go
      </a>
    </Button>
  );
}
