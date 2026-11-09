import { useState, type ReactNode } from "react";
import { useBotSendFailure } from "@/hooks/bots/use-bot-send-failure";
import { useKeptBoxDraft } from "@/hooks/bots/use-kept-box-draft";
import { BotIdentityContext } from "@/components/bots/bot-identity-context";
import { BotMessageComposer } from "@/components/bots/bot-message-composer";
import { BotTestRunnerHost } from "@/components/bots/__tests__/bot-test-runner-host";
import {
  BOT_ID,
  CHANNEL,
  OWNER_LABEL,
  THREAD,
} from "@/stores/bots/__tests__/bot-box-draft-persist-support";

/**
 * The bot message box with its owner's real state (Tracy Bots T158): the real
 * failure line and `useKeptBoxDraft`, and a button that swaps the channel's
 * box for its thread's. Loaded by the suites after an app start, so that it
 * shares that start's React and drafts store.
 */

function Box(props: { readonly conversation: string }): ReactNode {
  const failure = useBotSendFailure();
  const kept = useKeptBoxDraft(BOT_ID, props.conversation);
  return (
    <BotTestRunnerHost>
      <BotMessageComposer
        key={props.conversation}
        botId={BOT_ID}
        botTitle="Tracy"
        conversationId={CHANNEL}
        threadId={null}
        announcementId={null}
        sendable
        imageReach="none"
        placeholder={OWNER_LABEL}
        label={OWNER_LABEL}
        testId="bot-channel-composer"
        failure={failure}
        edit={null}
        onEditEnd={() => undefined}
        onEditResume={() => undefined}
        seed={kept.seed}
        keptDraft={kept.keptDraft}
        quote={null}
        onSent={() => false}
      />
    </BotTestRunnerHost>
  );
}

export function OwnerBox(props: { readonly initial: string }): ReactNode {
  const [conversation, setConversation] = useState(props.initial);
  return (
    <BotIdentityContext value={{ botId: BOT_ID, title: "Tracy", owner: null }}>
      <button
        type="button"
        data-testid="switch-conversation"
        onClick={() =>
          setConversation((current) => (current === CHANNEL ? THREAD : CHANNEL))
        }
      >
        Switch
      </button>
      <Box conversation={conversation} />
    </BotIdentityContext>
  );
}
