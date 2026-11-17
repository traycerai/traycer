import {
  createContext,
  use,
  useLayoutEffect,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { SoundtrackPlaybackControls } from "@/components/soundtrack/soundtrack-playback-controls";

const TracyPlaybackSlotContext = createContext<
  ((element: HTMLElement | null) => void) | null
>(null);

/**
 * The Tracy tab's one group of playback controls. It is drawn in the title
 * row of whichever view marks one with `TracyPlaybackSlot`, and in a row of
 * its own over the tab while no view does, so every state of the tab has
 * exactly one group without each state having to place it.
 *
 * The group is one mounted instance in a carrier element that is moved
 * between the two places, so a move restarts nothing the group holds, and
 * its place in the tab order is where it is drawn.
 */
export function TracyPlaybackScope(props: {
  readonly children: ReactNode;
}): ReactNode {
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  const [row, setRow] = useState<HTMLElement | null>(null);
  const [carrier] = useState(createCarrier);
  const target = slot ?? row;
  useLayoutEffect(() => {
    if (target === null || carrier.parentNode === target) return;
    moveInto(target, carrier);
  }, [carrier, target]);
  return (
    <TracyPlaybackSlotContext value={setSlot}>
      <div className="flex h-full min-h-0 flex-col">
        <div ref={setRow} className="contents" />
        {createPortal(
          <SoundtrackPlaybackControls
            placement={slot === null ? "surface" : "title-strip"}
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
 * Moves the carrier without tearing it down where the browser can (focus and
 * a running animation survive), and re-inserts it elsewhere.
 */
function moveInto(target: HTMLElement, carrier: HTMLElement): void {
  if (carrier.isConnected && "moveBefore" in target) {
    target.moveBefore(carrier, null);
    return;
  }
  target.appendChild(carrier);
}

/**
 * Where a view's title row takes the tab's playback controls, at the row's
 * end. The row names itself the `title-strip` container. Outside a Tracy tab
 * it holds nothing.
 */
export function TracyPlaybackSlot(): ReactNode {
  const setSlot = use(TracyPlaybackSlotContext);
  return (
    <span
      ref={setSlot ?? undefined}
      data-testid="tracy-playback-slot"
      className="ml-auto flex min-w-0 items-center"
    />
  );
}
