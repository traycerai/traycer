import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import type { ReactNode } from "react";
import type { BotSurfaceReference } from "@traycer/protocol/persistence/epic/messages";
import { BotArtifactReferenceCard } from "@/components/bots/bot-artifact-reference-card";
import { TracyTranscriptOriginScope } from "@/components/bots/tracy-transcript-origin-scope";
import { ChatExpansionTestProviders } from "@/components/chat/__tests__/chat-expansion-test-providers";
import { TooltipProvider } from "@/components/ui/tooltip";

/** The real artifact reference card in the providers a transcript gives it. */
export function ReaderCardTree(props: {
  readonly surface: Extract<BotSurfaceReference, { kind: "artifact" }>;
  readonly rowKey: string;
  readonly title: string;
  readonly queryClient: QueryClient;
}): ReactNode {
  return (
    <QueryClientProvider client={props.queryClient}>
      <TooltipProvider>
        <ChatExpansionTestProviders tileInstanceId="reader-card">
          <TracyTranscriptOriginScope botId="bot-1">
            <BotArtifactReferenceCard
              surface={props.surface}
              title={props.title}
              rowKey={props.rowKey}
            />
          </TracyTranscriptOriginScope>
        </ChatExpansionTestProviders>
      </TooltipProvider>
    </QueryClientProvider>
  );
}
