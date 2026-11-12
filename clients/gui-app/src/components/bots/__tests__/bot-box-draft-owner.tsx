import { useEffect, useRef, useState, type ReactNode } from "react";
import { useBotSendFailure } from "@/hooks/bots/use-bot-send-failure";
import { useKeptBoxDraft } from "@/hooks/bots/use-kept-box-draft";
import {
  useBotDraftsStore,
  type BotCarriedBlock,
} from "@/stores/bots/bot-drafts-store";
import { BotIdentityContext } from "@/components/bots/bot-identity-context";
import {
  BotMessageComposer,
  type BotComposerEdit,
} from "@/components/bots/bot-message-composer";
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

function Box(props: {
  readonly conversation: string;
  readonly edit: BotComposerEdit | null;
}): ReactNode {
  const failure = useBotSendFailure();
  // The edit lives with the owner, as the thread panel keeps it: the box's
  // send ends it, and a refused send resumes it.
  const [edit, setEdit] = useState<BotComposerEdit | null>(props.edit);
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
        edit={edit}
        onEditEnd={() => setEdit(null)}
        onEditResume={(resumed) => setEdit(resumed)}
        seed={kept.seed}
        keptDraft={kept.keptDraft}
        quote={null}
        moved={kept.moved}
        notice={kept.notice}
        onSent={() => false}
      />
    </BotTestRunnerHost>
  );
}

const NO_BLOCKS: ReadonlyArray<BotCarriedBlock> = [];

/**
 * A second writer of the drafts store, standing before the box: when `first`
 * shows among the blocks waiting for the box, it makes `move` in that same
 * commit, ahead of the box's own acknowledgement of the block, as another
 * card's settlement effect does.
 */
function SecondMover(props: {
  readonly boxKey: string;
  readonly first: string;
  readonly move: () => void;
}): ReactNode {
  const { boxKey, first, move } = props;
  const blocks = useBotDraftsStore(
    (state) => state.boxCarries[BOT_ID]?.[boxKey] ?? NO_BLOCKS,
  );
  const moved = useRef(false);
  useEffect(() => {
    if (moved.current || !blocks.some((item) => item.block === first)) {
      return;
    }
    moved.current = true;
    move();
  }, [blocks, first, move]);
  return null;
}

function OwnerBoxWith(props: {
  readonly initial: string;
  readonly before: ReactNode;
  readonly edit: BotComposerEdit | null;
}): ReactNode {
  const [conversation, setConversation] = useState(props.initial);
  return (
    <BotIdentityContext value={{ botId: BOT_ID, title: "Tracy", owner: null }}>
      {props.before}
      <button
        type="button"
        data-testid="switch-conversation"
        onClick={() =>
          setConversation((current) => (current === CHANNEL ? THREAD : CHANNEL))
        }
      >
        Switch
      </button>
      <Box conversation={conversation} edit={props.edit} />
    </BotIdentityContext>
  );
}

export function OwnerBox(props: { readonly initial: string }): ReactNode {
  return <OwnerBoxWith initial={props.initial} before={null} edit={null} />;
}

/** The box, with a second writer of the drafts store standing before it (`SecondMover`). */
export function OwnerBoxWithSecondMover(props: {
  readonly initial: string;
  readonly first: string;
  readonly move: () => void;
}): ReactNode {
  return (
    <OwnerBoxWith
      initial={props.initial}
      edit={null}
      before={
        <SecondMover
          boxKey={props.initial}
          first={props.first}
          move={props.move}
        />
      }
    />
  );
}

/** The box opened on an edit of a failed post (`edit`), as the thread panel opens it. */
export function OwnerBoxEditing(props: {
  readonly initial: string;
  readonly edit: BotComposerEdit;
}): ReactNode {
  return (
    <OwnerBoxWith initial={props.initial} before={null} edit={props.edit} />
  );
}
