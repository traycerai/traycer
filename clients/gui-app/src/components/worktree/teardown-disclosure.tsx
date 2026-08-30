import type { WorktreeBusyHolder } from "@traycer/protocol/framework/worktree-busy-holders";
import { cn } from "@/lib/utils";
import { teardownHolderRowKey } from "@/lib/worktree/owner-teardown-snapshot";
import {
  formatTeardownActors,
  type FormattedTeardownActor,
} from "@/lib/worktree/teardown-holder-copy";

/**
 * Compact grouped disclosure for a single-target teardown (rebind commit,
 * Settings force-delete). Actor sentences wrap; hold-kind tags are never
 * shown. Sweep uses {@link TeardownInlineDisclosure} inside each row.
 */
export function TeardownDisclosure(props: {
  readonly holders: readonly WorktreeBusyHolder[];
  readonly failures?: Readonly<Record<string, string>>;
  readonly agentNames: ReadonlyMap<string, string> | undefined;
}) {
  if (props.holders.length === 0) return null;
  const actors = formatTeardownActors(
    props.holders,
    props.agentNames ?? new Map(),
  );
  const working = actors.filter((actor) => actor.tone === "working");
  const idle = actors.filter((actor) => actor.tone === "idle");
  return (
    <div
      className="flex w-full min-w-0 flex-col gap-3 overflow-hidden"
      data-testid="teardown-disclosure"
    >
      {working.length > 0 ? (
        <ActorGroup
          testId="teardown-disclosure-working"
          heading={workingHeading(working)}
          actors={working}
          tone="working"
          failures={props.failures}
        />
      ) : null}
      {idle.length > 0 ? (
        <ActorGroup
          testId="teardown-disclosure-idle"
          heading={idleHeading(idle)}
          actors={idle}
          tone="idle"
          failures={props.failures}
        />
      ) : null}
    </div>
  );
}

/**
 * Worktree-scoped inline disclosure: heading + wrapping actor sentences,
 * no pooled type tags.
 */
export function TeardownInlineDisclosure(props: {
  readonly holders: readonly WorktreeBusyHolder[];
  readonly heading: string;
  readonly agentNames: ReadonlyMap<string, string> | undefined;
  readonly unknownConsequence: string | null;
}) {
  const actors = formatTeardownActors(
    props.holders,
    props.agentNames ?? new Map(),
  );
  if (actors.length === 0 && props.unknownConsequence === null) return null;
  return (
    <div
      className="mt-2 min-w-0 rounded-md border-l-2 border-amber-500/70 bg-amber-500/8 px-2.5 py-2"
      data-testid="teardown-disclosure-inline"
    >
      <p className="text-ui-xs font-medium text-foreground">{props.heading}</p>
      <ul className="m-0 mt-1 flex list-none flex-col gap-1 p-0">
        {props.unknownConsequence !== null ? (
          <li className="text-ui-xs wrap-anywhere text-foreground">
            {props.unknownConsequence}
          </li>
        ) : (
          actors.map((actor) => (
            <li
              key={actor.key}
              className="text-ui-xs wrap-anywhere text-foreground"
            >
              {actor.sentence}
              {actor.evidence.map((line) => (
                <span
                  key={line}
                  className="mt-0.5 block wrap-anywhere text-muted-foreground"
                >
                  {line}
                </span>
              ))}
            </li>
          ))
        )}
      </ul>
    </div>
  );
}

function ActorGroup(props: {
  readonly testId: string;
  readonly heading: string;
  readonly actors: readonly FormattedTeardownActor[];
  readonly tone: "working" | "idle";
  readonly failures: Readonly<Record<string, string>> | undefined;
}) {
  return (
    <section
      className="flex min-w-0 flex-col gap-1.5"
      data-testid={props.testId}
    >
      <p
        className={cn(
          "text-ui-sm font-medium",
          props.tone === "working"
            ? "text-foreground"
            : "text-muted-foreground",
        )}
      >
        {props.heading}
      </p>
      <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
        {props.actors.map((actor) => {
          const failure = firstFailure(actor, props.failures);
          return (
            <li
              key={actor.key}
              className={cn(
                "flex min-w-0 flex-col gap-0.5 rounded-md px-2 py-1 text-ui-sm",
                props.tone === "working"
                  ? "bg-foreground/8"
                  : "bg-foreground/3",
              )}
            >
              <span
                className="min-w-0 wrap-anywhere text-foreground"
                data-testid="teardown-holder-label"
              >
                {actor.sentence}
              </span>
              {actor.evidence.map((line) => (
                <span
                  key={line}
                  className="min-w-0 wrap-anywhere text-ui-xs text-muted-foreground"
                >
                  {line}
                </span>
              ))}
              {failure === undefined ? null : (
                <span
                  className="text-ui-xs text-destructive"
                  data-testid="teardown-holder-failure"
                >
                  {failure}
                </span>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function firstFailure(
  actor: FormattedTeardownActor,
  failures: Readonly<Record<string, string>> | undefined,
): string | undefined {
  if (failures === undefined) return undefined;
  for (const holder of actor.holders) {
    const rowKey = teardownHolderRowKey(holder);
    if (Object.hasOwn(failures, rowKey)) return failures[rowKey];
  }
  return undefined;
}

function workingHeading(actors: readonly FormattedTeardownActor[]): string {
  const holders = actors.flatMap((actor) => actor.holders);
  const agents = holders.filter(
    (holder) =>
      holder.holdKind === "chat-turn" ||
      holder.holdKind === "terminal-agent-pty",
  ).length;
  const shells = holders.filter(
    (holder) => holder.holdKind === "supervised-shell",
  ).length;
  const parts: string[] = [];
  if (agents === 1) parts.push("1 agent is still working");
  if (agents > 1) parts.push(`${agents} agents are still working`);
  if (shells === 1) parts.push("1 shell is running");
  if (shells > 1) parts.push(`${shells} shells are running`);
  if (parts.length === 0) {
    return holders.length === 1
      ? "1 process is still working"
      : `${holders.length} processes are still working`;
  }
  return parts.join(" · ");
}

function idleHeading(actors: readonly FormattedTeardownActor[]): string {
  const count = actors.length;
  return count === 1
    ? "1 background process will be stopped"
    : `${String(count)} background processes will be stopped`;
}
