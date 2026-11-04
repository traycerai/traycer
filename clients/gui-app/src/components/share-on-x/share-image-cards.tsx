import { useId, type ReactNode } from "react";
import gradientBackdrop from "@/assets/brand/gradient-bg.jpg";
import { normalizeProviderId } from "@/components/home/data/landing-options";
import { HarnessIcon } from "@/components/home/pickers/harness-icon";
import { TraycerIcon } from "@/components/home/pickers/harness-icons";
import type { SetUpHarness } from "@/components/share-on-x/set-up-harnesses";
import type {
  ShareUsageAgent,
  ShareUsageFacts,
} from "@/components/share-on-x/share-usage-facts";
import { formatDayLabel } from "@/lib/usage-analytics/format-metric-value";
import "./share-image.css";

/** The family the pixel accent sets in, declared by `share-image.css`. */
export const SHARE_PIXEL_FONT_FAMILY = "Geist Pixel Square";

const SITE = "traycer.ai";

/** Most agents an image names before it folds the rest into "+N". */
const MAX_NAMED_AGENTS = 4;

/**
 * Traycer's social card: the dimmed brand backdrop, the lockup, and a mono
 * tag either in the footer (under a rule, beside the site) or in the header.
 */
function ShareImageFrame(props: {
  readonly tag: string;
  readonly tagPlacement: "footer" | "header";
  readonly children: ReactNode;
}): ReactNode {
  return (
    <div className="share-image">
      <img src={gradientBackdrop} alt="" className="share-image__backdrop" />
      <div className="share-image__wash" />
      <div className="share-image__lockup">
        <TraycerIcon aria-hidden="true" className="share-image__lockup-mark" />
        traycer
      </div>
      {props.children}
      {props.tagPlacement === "header" ? (
        <span className="share-image__tag share-image__tag--header">
          {props.tag}
        </span>
      ) : (
        <>
          <div className="share-image__rule" />
          <div className="share-image__footer">
            <span className="share-image__site">{SITE}</span>
            <span className="share-image__tag">{props.tag}</span>
          </div>
        </>
      )}
    </div>
  );
}

const COUNT_WORDS = [
  "",
  "One",
  "Two",
  "Three",
  "Four",
  "Five",
  "Six",
  "Seven",
  "Eight",
  "Nine",
];

function countWord(count: number): string {
  return COUNT_WORDS.at(count) ?? String(count);
}

function plural(count: number, one: string, many: string): string {
  return `${String(count)} ${count === 1 ? one : many}`;
}

const COMPACT_NUMBER = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 1,
});

interface SetUpRow {
  readonly key: string;
  /** A harness icon, or the "+N" count of the agents left unnamed. */
  readonly mark: { readonly iconId: string } | { readonly more: number };
  readonly label: string;
}

function setUpRows(harnesses: ReadonlyArray<SetUpHarness>): SetUpRow[] {
  const fitsAll = harnesses.length <= MAX_NAMED_AGENTS + 1;
  const shown = fitsAll ? harnesses : harnesses.slice(0, MAX_NAMED_AGENTS);
  const rows: SetUpRow[] = shown.map((harness) => ({
    key: harness.id,
    // The provider list names Claude Code `claude-code`; its icon is keyed
    // by the id it runs under.
    mark: { iconId: normalizeProviderId(harness.id) ?? harness.id },
    label: harness.name,
  }));
  if (fitsAll) return rows;
  return [
    ...rows,
    {
      key: "more",
      mark: { more: harnesses.length - MAX_NAMED_AGENTS },
      label: "more agents",
    },
  ];
}

/** The diagram box, `.share-image__diagram`: 448 × 473. */
const DIAGRAM_HEIGHT = 473;
const DIAGRAM_HUB_RIGHT = 76;
const DIAGRAM_TRUNK_X = 116;
const DIAGRAM_NODE_X = 150;

/** Every agent set up on this machine, wired to Traycer. */
export function SetUpImage(props: {
  readonly harnesses: ReadonlyArray<SetUpHarness>;
}): ReactNode {
  const count = props.harnesses.length;
  const rows = setUpRows(props.harnesses);
  const node = rows.length <= 3 ? 64 : 54;
  const pitch = rows.length <= 3 ? 104 : 86;
  const hubY = DIAGRAM_HEIGHT / 2;
  const firstY = hubY - ((rows.length - 1) * pitch) / 2;
  const lastY = firstY + (rows.length - 1) * pitch;
  return (
    <ShareImageFrame tag="Bring your own agents" tagPlacement="footer">
      <div className="share-image__body share-image__setup-copy">
        <p className="share-image__eyebrow">My coding agents</p>
        <h2 className="share-image__headline">
          {count === 1
            ? "My coding agent."
            : `${countWord(count)} coding agents.`}
          <br />
          <span className="share-image__pixel">One</span> nerve center.
        </h2>
        <p className="share-image__subcopy">
          Shared context, agent handoffs, and the subscriptions I already pay
          for.
        </p>
      </div>
      <div className="share-image__diagram">
        <svg
          aria-hidden="true"
          className="share-image__wires"
          viewBox={`0 0 448 ${String(DIAGRAM_HEIGHT)}`}
          fill="none"
        >
          <line
            x1={DIAGRAM_HUB_RIGHT}
            y1={hubY}
            x2={DIAGRAM_TRUNK_X}
            y2={hubY}
          />
          <line
            x1={DIAGRAM_TRUNK_X}
            y1={Math.min(firstY, hubY)}
            x2={DIAGRAM_TRUNK_X}
            y2={Math.max(lastY, hubY)}
          />
          {rows.map((row, index) => (
            <line
              key={row.key}
              x1={DIAGRAM_TRUNK_X}
              y1={firstY + index * pitch}
              x2={DIAGRAM_NODE_X}
              y2={firstY + index * pitch}
            />
          ))}
        </svg>
        <span
          className="share-image__node share-image__hub"
          style={{ top: hubY }}
        >
          <TraycerIcon aria-hidden="true" className="share-image__hub-mark" />
        </span>
        <span className="share-image__hub-label" style={{ top: hubY + 50 }}>
          shared context
        </span>
        {rows.map((row, index) => (
          <div
            key={row.key}
            className="share-image__row"
            style={{ left: DIAGRAM_NODE_X, top: firstY + index * pitch }}
          >
            <span
              className="share-image__node"
              style={{ width: node, height: node }}
            >
              {"iconId" in row.mark ? (
                <span
                  className="flex"
                  style={{ width: node * 0.46, height: node * 0.46 }}
                >
                  <HarnessIcon
                    harnessId={row.mark.iconId}
                    className="size-full text-white"
                  />
                </span>
              ) : (
                <span className="share-image__more">
                  +{String(row.mark.more)}
                </span>
              )}
            </span>
            <span className="share-image__row-name">{row.label}</span>
          </div>
        ))}
      </div>
    </ShareImageFrame>
  );
}

function AgentChips(props: {
  readonly agents: ReadonlyArray<ShareUsageAgent>;
}): ReactNode {
  const shown = props.agents.slice(0, MAX_NAMED_AGENTS);
  const rest = props.agents.length - shown.length;
  return (
    <div className="share-image__chips">
      {shown.map((agent) => (
        <span key={agent.id} className="share-image__chip">
          <HarnessIcon
            harnessId={agent.id}
            className="share-image__chip-icon text-white"
          />
          {agent.name}
        </span>
      ))}
      {rest > 0 ? (
        <span className="share-image__chip">+{String(rest)} more</span>
      ) : null}
    </div>
  );
}

/** The task's title, and the agents that worked on it this week. */
export function TaskCardImage(props: {
  readonly title: string;
  readonly facts: ShareUsageFacts | null;
}): ReactNode {
  const { facts } = props;
  const named = facts !== null && facts.agents.length > 0;
  const tag = named
    ? `${plural(facts.agents.length, "agent", "agents")} · ${plural(facts.chatCount, "chat", "chats")} this week`
    : "The nerve center for agentic coding";
  return (
    <ShareImageFrame tag={tag} tagPlacement="footer">
      <TraycerIcon
        aria-hidden="true"
        className="share-image__ghost text-white"
      />
      <div className="share-image__body share-image__card-copy">
        <p className="share-image__eyebrow">Now building</p>
        <h2 className="share-image__title">{props.title}</h2>
        {named ? <AgentChips agents={facts.agents} /> : null}
      </div>
    </ShareImageFrame>
  );
}

const PLOT_WIDTH = 468;
const PLOT_HEIGHT = 286;
const TICK_KEYS = ["first", "middle", "last"];

function DailyTokensChart(props: {
  readonly days: ShareUsageFacts["days"];
}): ReactNode {
  const fadeId = `share-usage-fade-${useId().replace(/:/g, "")}`;
  const { days } = props;
  const max = Math.max(...days.map((day) => day.tokens), 1);
  const step = days.length > 1 ? PLOT_WIDTH / (days.length - 1) : 0;
  const points = days.map((day, index) => ({
    x: days.length > 1 ? index * step : PLOT_WIDTH / 2,
    y: PLOT_HEIGHT - (day.tokens / max) * (PLOT_HEIGHT - 12),
  }));
  const line = points
    .map(
      (point, index) =>
        `${index === 0 ? "M" : "L"}${point.x.toFixed(1)} ${point.y.toFixed(1)}`,
    )
    .join(" ");
  const first = points.at(0);
  const last = points.at(-1);
  const ticks = [days.at(0), days.at(Math.floor(days.length / 2)), days.at(-1)];
  return (
    <div className="share-image__body share-image__chart">
      <p className="share-image__chart-label">Daily tokens</p>
      <svg
        aria-hidden="true"
        className="share-image__plot"
        width={PLOT_WIDTH}
        height={PLOT_HEIGHT}
        viewBox={`0 0 ${String(PLOT_WIDTH)} ${String(PLOT_HEIGHT)}`}
        overflow="visible"
      >
        <defs>
          <linearGradient id={fadeId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="currentColor" stopOpacity={0.3} />
            <stop offset="100%" stopColor="currentColor" stopOpacity={0} />
          </linearGradient>
        </defs>
        <line
          className="share-image__plot-axis"
          x1={0}
          y1={PLOT_HEIGHT}
          x2={PLOT_WIDTH}
          y2={PLOT_HEIGHT}
        />
        {first === undefined || last === undefined ? null : (
          <>
            <path
              d={`${line} L${last.x.toFixed(1)} ${String(PLOT_HEIGHT)} L${first.x.toFixed(1)} ${String(PLOT_HEIGHT)} Z`}
              fill={`url(#${fadeId})`}
            />
            <path
              d={line}
              fill="none"
              stroke="currentColor"
              strokeWidth={2.5}
              strokeLinejoin="round"
              strokeLinecap="round"
            />
            <circle
              cx={last.x}
              cy={last.y}
              r={11}
              fill="none"
              stroke="currentColor"
              strokeOpacity={0.45}
            />
            <circle cx={last.x} cy={last.y} r={5} fill="currentColor" />
          </>
        )}
      </svg>
      <div className="share-image__chart-ticks">
        {ticks.map((tick, index) => (
          <span key={TICK_KEYS[index]}>
            {tick === undefined ? "" : formatDayLabel(tick.day)}
          </span>
        ))}
      </div>
    </div>
  );
}

/** The task's tokens over the window, and how its agents shared them. */
export function UsageImage(props: {
  readonly facts: ShareUsageFacts;
}): ReactNode {
  const { facts } = props;
  return (
    <ShareImageFrame tag={facts.rangeLabel} tagPlacement="footer">
      <div className="share-image__body share-image__usage-copy">
        <p className="share-image__eyebrow">
          This task · last {String(facts.days.length)} days
        </p>
        <div className="share-image__figure">
          <span className="share-image__number">
            {COMPACT_NUMBER.format(facts.totalTokens)}
          </span>
          <span className="share-image__number-label">
            tokens across {plural(facts.agents.length, "agent", "agents")} and{" "}
            {plural(facts.chatCount, "chat", "chats")}
          </span>
        </div>
        <div className="share-image__split">
          {facts.agents.slice(0, 3).map((agent) => (
            <div key={agent.id} className="share-image__split-row">
              <HarnessIcon
                harnessId={agent.id}
                className="share-image__split-icon text-white"
              />
              <span className="share-image__split-name">{agent.name}</span>
              <span className="share-image__split-track">
                <span
                  className="share-image__split-fill"
                  style={{
                    width: `${String(Math.max(agent.share * 100, 2))}%`,
                  }}
                />
              </span>
              <span className="share-image__split-share">
                {String(Math.round(agent.share * 100))}%
              </span>
            </div>
          ))}
        </div>
      </div>
      <DailyTokensChart days={facts.days} />
    </ShareImageFrame>
  );
}

/** The window as it was when the person chose to share, framed. */
export function ScreenImage(props: { readonly src: string }): ReactNode {
  return (
    <ShareImageFrame tag="Live from my workspace" tagPlacement="header">
      <div className="share-image__window">
        <img src={props.src} alt="" />
      </div>
    </ShareImageFrame>
  );
}
