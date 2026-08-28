import type { WorktreeBusyHolder } from "@traycer/protocol/framework/worktree-busy-holders";
import { cn } from "@/lib/utils";
import { teardownHolderRowKey } from "@/lib/worktree/owner-teardown-snapshot";

/**
 * Renders a T2 holder list as "what will be stopped". Source-agnostic: the
 * list may come from the phase-1 client-local snapshot or, later, the host
 * `listHolders` read. Empty renders nothing.
 */
export function TeardownDisclosure(props: {
  readonly holders: readonly WorktreeBusyHolder[];
  readonly failures?: Readonly<Record<string, string>>;
}) {
  if (props.holders.length === 0) return null;
  const working = props.holders.filter(
    (holder) => holder.activity === "working",
  );
  const idle = props.holders.filter((holder) => holder.activity === "idle");
  return (
    <div
      className="flex w-full min-w-0 flex-col gap-3 overflow-hidden"
      data-testid="teardown-disclosure"
    >
      {working.length > 0 ? (
        <HolderGroup
          testId="teardown-disclosure-working"
          heading={workingHeading(working)}
          holders={working}
          tone="working"
          failures={props.failures}
        />
      ) : null}
      {idle.length > 0 ? (
        <HolderGroup
          testId="teardown-disclosure-idle"
          heading={idleHeading(idle)}
          holders={idle}
          tone="idle"
          failures={props.failures}
        />
      ) : null}
    </div>
  );
}

function HolderGroup(props: {
  readonly testId: string;
  readonly heading: string;
  readonly holders: readonly WorktreeBusyHolder[];
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
        {props.holders.map((holder) => {
          const key = teardownHolderRowKey(holder);
          const failure = props.failures?.[key];
          return (
            <li
              key={key}
              className={cn(
                "flex min-w-0 flex-col gap-0.5 rounded-md px-2 py-1 text-ui-sm",
                props.tone === "working"
                  ? "bg-foreground/8"
                  : "bg-foreground/3",
              )}
            >
              <div className="flex min-w-0 items-baseline gap-2">
                <span
                  className="min-w-0 flex-1 wrap-anywhere text-foreground"
                  data-testid="teardown-holder-label"
                >
                  {holder.label}
                </span>
                <span className="shrink-0 text-ui-xs text-muted-foreground">
                  {holdKindLabel(holder.holdKind)}
                </span>
              </div>
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

function holdKindLabel(holdKind: WorktreeBusyHolder["holdKind"]): string {
  if (holdKind === "chat-turn") return "Turn";
  if (holdKind === "terminal-agent-pty") return "Terminal";
  if (holdKind === "supervised-shell") return "Shell";
  return "Run directory";
}

function workingHeading(holders: readonly WorktreeBusyHolder[]): string {
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

function idleHeading(holders: readonly WorktreeBusyHolder[]): string {
  return holders.length === 1
    ? "1 background process will be stopped"
    : `${holders.length} background processes will be stopped`;
}
