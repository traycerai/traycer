import type { ReactNode } from "react";
import { HarnessIcon } from "@/components/home/pickers/harness-icon";
import { TraycerIcon } from "@/components/home/pickers/harness-icons";
import type { SetUpHarness } from "@/components/share-on-x/set-up-harnesses";
import { cn } from "@/lib/utils";

/**
 * The share images are pictures, not app surfaces: each is drawn at a fixed
 * 800×450 CSS size (1600×900 once rasterised at 2×, X's 16:9 card) on its
 * own dark ground, the same in every theme, so a post looks the same
 * whichever theme the person shares from.
 */
const IMAGE_FRAME =
  "relative h-112.5 w-200 overflow-hidden bg-black font-sans text-white";

const SITE = "traycer.ai";

interface Point {
  readonly x: number;
  readonly y: number;
}

/** Most harnesses the setup image names before it folds the rest into "+N more". */
const MAX_NAMED_HARNESSES = 4;
const SLOTS_AROUND_HUB: ReadonlyArray<Point> = [
  { x: 400, y: 72 },
  { x: 165, y: 160 },
  { x: 635, y: 160 },
  { x: 235, y: 318 },
  { x: 565, y: 318 },
];

interface SetUpLayout {
  readonly hub: Point;
  readonly nodes: ReadonlyArray<{
    readonly at: Point;
    readonly harness: SetUpHarness | null;
    readonly label: string;
  }>;
  readonly caption: string;
}

function layoutSetUp(harnesses: ReadonlyArray<SetUpHarness>): SetUpLayout {
  const count = harnesses.length;
  const named = (harness: SetUpHarness, at: Point) => ({
    at,
    harness,
    label: harness.name,
  });
  if (count === 1) {
    const [only] = harnesses;
    return {
      hub: { x: 290, y: 200 },
      nodes: [named(only, { x: 520, y: 200 })],
      caption: `${only.name} with Traycer · ${SITE}`,
    };
  }
  const caption = `${String(count)} agents, one workspace · ${SITE}`;
  if (count === 2) {
    return {
      hub: { x: 400, y: 200 },
      nodes: [
        named(harnesses[0], { x: 175, y: 200 }),
        named(harnesses[1], { x: 625, y: 200 }),
      ],
      caption,
    };
  }
  const fitsAll = count <= SLOTS_AROUND_HUB.length;
  const shown = fitsAll ? harnesses : harnesses.slice(0, MAX_NAMED_HARNESSES);
  const nodes = shown.map((harness, index) =>
    named(harness, SLOTS_AROUND_HUB[index]),
  );
  return {
    hub: { x: 400, y: 200 },
    nodes: fitsAll
      ? nodes
      : [
          ...nodes,
          {
            at: SLOTS_AROUND_HUB[MAX_NAMED_HARNESSES],
            harness: null,
            label: `+${String(count - MAX_NAMED_HARNESSES)} more`,
          },
        ],
    caption,
  };
}

/** Traycer at the hub, joined to every harness set up on this machine. */
export function SetUpImage(props: {
  readonly harnesses: ReadonlyArray<SetUpHarness>;
}): ReactNode {
  const layout = layoutSetUp(props.harnesses);
  return (
    <div className={IMAGE_FRAME}>
      <svg
        aria-hidden="true"
        className="absolute inset-0 size-full"
        viewBox="0 0 800 450"
      >
        {layout.nodes.map((node) => (
          <line
            key={node.label}
            x1={layout.hub.x}
            y1={layout.hub.y}
            x2={node.at.x}
            y2={node.at.y}
            stroke="currentColor"
            strokeOpacity={0.35}
            strokeWidth={2}
            strokeDasharray="6 6"
          />
        ))}
      </svg>
      <div
        className="absolute flex -translate-x-1/2 -translate-y-1/2 flex-col items-center gap-2"
        style={{ left: layout.hub.x, top: layout.hub.y }}
      >
        <span className="flex size-20 items-center justify-center rounded-full bg-white text-black">
          <TraycerIcon aria-hidden="true" className="size-10" />
        </span>
        <span className="text-base font-semibold">Traycer</span>
      </div>
      {layout.nodes.map((node) => (
        // The black ground under the translucent chip stops the wire
        // showing through it.
        <div
          key={node.label}
          className="absolute -translate-x-1/2 -translate-y-1/2 rounded-xl bg-black"
          style={{ left: node.at.x, top: node.at.y }}
        >
          <div className="flex items-center gap-2.5 rounded-xl border border-white/15 bg-white/10 px-4 py-3">
            {node.harness === null ? null : (
              <HarnessIcon
                harnessId={node.harness.id}
                className="size-6 text-white"
              />
            )}
            <span className="text-lg font-semibold whitespace-nowrap">
              {node.label}
            </span>
          </div>
        </div>
      ))}
      <p className="absolute inset-x-0 bottom-8 text-center text-sm text-white/60">
        {layout.caption}
      </p>
    </div>
  );
}

/** The task's title on a card with Traycer's name, for a post about it. */
export function TaskCardImage(props: { readonly title: string }): ReactNode {
  return (
    <div className={cn(IMAGE_FRAME, "flex flex-col justify-between p-14")}>
      <div className="flex items-center gap-3">
        <span className="flex size-10 items-center justify-center rounded-full bg-white text-black">
          <TraycerIcon aria-hidden="true" className="size-5" />
        </span>
        <span className="text-xl font-semibold">Traycer</span>
      </div>
      <p className="line-clamp-3 text-5xl leading-tight font-semibold">
        {props.title}
      </p>
      <p className="text-base text-white/60">Built with Traycer · {SITE}</p>
    </div>
  );
}
