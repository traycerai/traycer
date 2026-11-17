import {
  createContext,
  use,
  useCallback,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { SoundtrackPlaybackControls } from "@/components/soundtrack/soundtrack-playback-controls";

/** Takes a title row's place for the controls; the answer gives it up. */
type ClaimSlot = (slot: HTMLElement) => () => void;

const TracyPlaybackSlotContext = createContext<ClaimSlot | null>(null);

/**
 * The Tracy tab's one group of playback controls. It is drawn in the title
 * row of whichever view marks one with `TracyPlaybackSlot`, and in a row of
 * its own over the tab while no view does, so every state of the tab has
 * exactly one group without each state having to place it.
 *
 * The group is one mounted instance inside a carrier element that is moved
 * between the two places, so its place in the tab order is where it is
 * drawn. A title row gives its claim up while its element is still attached,
 * so the carrier is still in the document when it parks in the row, and what
 * a move loses (focus, a running title) can be read then. The title row that
 * replaces it in the same commit takes it from the row before anything is
 * painted, and what was read is put back where the carrier came to rest.
 *
 * A scope inside another draws nothing of its own: the outer one holds the
 * group.
 */
export function TracyPlaybackScope(props: {
  readonly children: ReactNode;
}): ReactNode {
  return use(TracyPlaybackSlotContext) === null ? (
    <OwnTracyPlaybackScope>{props.children}</OwnTracyPlaybackScope>
  ) : (
    props.children
  );
}

function OwnTracyPlaybackScope(props: {
  readonly children: ReactNode;
}): ReactNode {
  const [carrier] = useState(createCarrier);
  const [inTitleRow, setInTitleRow] = useState(false);
  const row = useRef<HTMLElement | null>(null);
  const owner = useRef<HTMLElement | null>(null);
  // What the move under way would lose, read once before the carrier first
  // left its place and put back where it comes to rest.
  const kept = useRef<(() => void) | null>(null);
  // The scope's own teardown leaves the carrier where it is: every place it
  // could go is leaving with it.
  const leaving = useRef(false);
  const [, settle] = useReducer((moves: number) => moves + 1, 0);
  const move = useCallback(
    (target: HTMLElement) => {
      if (carrier.parentNode === target) return;
      kept.current ??= keepAcrossReinsert(carrier);
      target.appendChild(carrier);
      // The scope renders again, and its effect below puts back what was
      // kept, in the same task and so before the move is painted.
      settle();
    },
    [carrier],
  );
  // Runs after every commit's title rows have let go and claimed, so the
  // carrier is where it will be painted.
  useLayoutEffect(() => {
    leaving.current = false;
    kept.current?.();
    kept.current = null;
    return () => {
      leaving.current = true;
    };
  });
  const holdRow = useCallback(
    (element: HTMLElement | null) => {
      row.current = element;
      if (element !== null && owner.current === null) move(element);
    },
    [move],
  );
  const claim = useCallback<ClaimSlot>(
    (slot) => {
      owner.current = slot;
      move(slot);
      setInTitleRow(true);
      return () => {
        // A title row that was replaced before it let go no longer holds
        // the carrier, and has nothing to give up.
        if (owner.current !== slot) return;
        owner.current = null;
        if (leaving.current) return;
        if (row.current !== null) move(row.current);
        setInTitleRow(false);
      };
    },
    [move],
  );
  return (
    <TracyPlaybackSlotContext value={claim}>
      <div className="flex h-full min-h-0 flex-col">
        <div ref={holdRow} className="contents" />
        {createPortal(
          <SoundtrackPlaybackControls
            placement={inTitleRow ? "title-strip" : "surface"}
          />,
          carrier,
        )}
        <div className="min-h-0 flex-1">{props.children}</div>
      </div>
    </TracyPlaybackSlotContext>
  );
}

function createCarrier(): HTMLElement {
  const carrier = document.createElement("div");
  carrier.className = "contents";
  return carrier;
}

/**
 * What taking the carrier out of the document loses, read before it and put
 * back by the answer once the carrier is where it stays: focus, where one of
 * its controls had it and nothing has taken it since; and how far the title
 * had scrolled, on the animation that replaces it on the same element. A
 * title for another track is another element, and gets nothing put back;
 * whether the title runs or holds still stays its own style's to say.
 *
 * The browser's in-place move would lose neither, and is not used: Chromium
 * has crashed computing styles when one coincided with a commit's other
 * changes to the tree.
 */
function keepAcrossReinsert(carrier: HTMLElement): () => void {
  const focused =
    document.activeElement instanceof HTMLElement &&
    carrier.contains(document.activeElement)
      ? document.activeElement
      : null;
  // A document with no animations (a test's) has none to keep.
  const runs =
    carrier.isConnected && "getAnimations" in carrier
      ? carrier.getAnimations({ subtree: true }).flatMap((animation) => {
          const target =
            animation.effect instanceof KeyframeEffect
              ? animation.effect.target
              : null;
          return target === null || !(animation instanceof CSSAnimation)
            ? []
            : [
                {
                  target,
                  name: animation.animationName,
                  time: animation.currentTime,
                },
              ];
        })
      : [];
  return () => {
    for (const run of runs) {
      if (!run.target.isConnected) continue;
      const next = run.target
        .getAnimations()
        .find(
          (animation) =>
            animation instanceof CSSAnimation &&
            animation.animationName === run.name,
        );
      if (next !== undefined) next.currentTime = run.time;
    }
    if (
      focused !== null &&
      focused.isConnected &&
      (document.activeElement === null ||
        document.activeElement === document.body) &&
      (!("checkVisibility" in focused) || focused.checkVisibility())
    ) {
      focused.focus({ preventScroll: true });
    }
  };
}

/**
 * Where a view's title row takes the tab's playback controls, at the row's
 * end. The row names itself the `title-strip` container. Outside a Tracy tab
 * it holds nothing.
 */
export function TracyPlaybackSlot(): ReactNode {
  const claim = use(TracyPlaybackSlotContext);
  // React runs a removed element's ref cleanup while the element is still in
  // the document, which is what lets the carrier leave it attached.
  const ref = useMemo(
    () => (claim === null ? undefined : (slot: HTMLElement) => claim(slot)),
    [claim],
  );
  return (
    <span
      ref={ref}
      data-testid="tracy-playback-slot"
      className="ml-auto flex min-w-0 items-center"
    />
  );
}

/**
 * A Tracy tab on its way to a channel, before the channel's own header
 * exists: the header's title row over what the tab shows meanwhile. The row
 * holds the playback controls where the header will draw them and is as tall
 * as the header, so nothing under it moves when the header takes its place.
 * Before the controls come `identity` (the bot's picture and name), or a bar
 * while there is no name to show. Where the app's header carries the
 * channel's title (`titled` false) there is no row here to keep.
 */
export function TracyOpening(props: {
  readonly titled: boolean;
  /** The bot's picture and name; `null` while they are not known. */
  readonly identity: ReactNode;
  readonly children: ReactNode;
}): ReactNode {
  if (!props.titled) return props.children;
  return (
    <div className="flex size-full min-h-0 min-w-0 flex-col">
      <header
        data-testid="bot-channel-opening-header"
        // The channel header's own box: its top padding, its title row, and
        // under it the gap and the Messages and Activity strip.
        className="@container/title-strip flex min-h-19 shrink-0 items-center gap-2 px-4 pt-3 pb-9"
      >
        {props.identity ?? (
          <span
            aria-hidden="true"
            className="h-4 w-32 max-w-1/3 rounded-sm bg-foreground/10"
          />
        )}
        <TracyPlaybackSlot />
      </header>
      <div className="flex min-h-0 flex-1 flex-col">{props.children}</div>
    </div>
  );
}
