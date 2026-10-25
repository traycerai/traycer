import type {
  EnvironmentOs,
  EnvironmentReviewEntry,
} from "@traycer/protocol/host/environment-schemas";
import type { HeldRow } from "@/components/settings/move/retrospective-sheet";
import {
  reviewEntryFacts,
  type ReviewEntryFacts,
} from "@/components/settings/move/review-v11";
import { harnessLabel } from "@/components/settings/panels/fallback/fallback-harness-label";

const HELD_REASONS = new Set(["credential_like_value", "executable_entry"]);

const VALUE_DETAIL = "looked like a key and was held.";

/**
 * Approve writes the held entry as Personal's item (`applyHeldEntry`, a live
 * commit), so it reaches every computer and sandbox running Personal, not
 * only the one it came from.
 */
const EVERYWHERE = "every computer and sandbox running Personal";

const OS_LABELS: Readonly<Record<EnvironmentOs, string | null>> = {
  any: null,
  macos: "macOS",
  linux: "Linux",
  windows: "Windows",
};

/** Held values and executable entries; grant-needed writes stay on the page notices. */
export function heldReviewEntries(
  entries: readonly EnvironmentReviewEntry[],
): readonly EnvironmentReviewEntry[] {
  return entries.filter((entry) => HELD_REASONS.has(entry.reason));
}

export function heldRowsFromReview(
  entries: readonly EnvironmentReviewEntry[],
): readonly HeldRow[] {
  return heldReviewEntries(entries).map((entry) => {
    if (entry.reason !== "executable_entry") {
      return {
        heldId: entry.entryId,
        name: entry.key,
        kind: "value",
        detail: VALUE_DETAIL,
      };
    }
    const line = heldCommandLine(entry);
    return {
      heldId: entry.entryId,
      name: line.name,
      kind: "command",
      detail: `${line.clause}. ${line.reach}`,
    };
  });
}

/**
 * One held executable's line, in three parts both the retrospective sheet
 * and the Overview's banner read: the name it goes by, what it does
 * (`(MCP server) runs <command>`), and who gets it once approved. `acts` is
 * false when the clause names the kind alone (a host below
 * `environment.review@1.2`, or a row the host could not describe).
 */
export interface HeldCommandLine {
  readonly name: string;
  readonly clause: string;
  readonly acts: boolean;
  readonly reach: string;
}

const RUNS_EVERYWHERE = `Once approved, it runs on ${EVERYWHERE}.`;

export function heldCommandLine(
  entry: EnvironmentReviewEntry,
): HeldCommandLine {
  const facts = reviewEntryFacts(entry);
  switch (entry.kind) {
    case "mcp_server":
      return runsLine(entry.key, "MCP server", facts.command);
    case "skill":
      return {
        name: entry.key,
        clause: `(skill) gives agents instructions for ${facts.description ?? "a kind of task"}`,
        acts: true,
        reach: `Once approved, every provider on ${EVERYWHERE} can use it.`,
      };
    case "shell":
      return shellLine(entry.key, OS_LABELS[entry.os], facts.command);
    case "setup_script":
      // Only a sandbox runs a setup script (the host registers its applier
      // on sandbox hosts alone), and it names no trigger of its own.
      return {
        name: entry.key,
        clause: `(setup script) runs ${facts.command === null ? "" : `${facts.command} `}when a sandbox first gets it or it changes`,
        acts: true,
        reach:
          "Once approved, it runs on every sandbox running Personal, never on a computer.",
      };
    case "agent_definition":
      return {
        name: entry.key,
        clause: `(agent definition) describes an agent ${facts.harness === null ? "a provider" : harnessLabel(facts.harness)} can start`,
        acts: true,
        reach: `Once approved, ${EVERYWHERE} gets it.`,
      };
    case "variable":
    case "env_override":
      return variableLine(entry, facts);
    default:
      // No held entry is a hook today; a host that holds one names its event.
      if (facts.event !== null) {
        return {
          name: entry.key,
          clause:
            facts.command === null
              ? "(hook)"
              : `(hook) runs ${facts.command} on ${facts.event}`,
          acts: facts.command !== null,
          reach: RUNS_EVERYWHERE,
        };
      }
      // A kind newer than this line set: named as the host spells it.
      return runsLine(
        entry.key,
        entry.kind.replaceAll("_", " "),
        facts.command,
      );
  }
}

/** `<name> (MCP server) runs <command>`, or the kind alone without a command. */
function runsLine(
  name: string,
  kind: string,
  command: string | null,
): HeldCommandLine {
  return {
    name,
    clause: command === null ? `(${kind})` : `(${kind}) runs ${command}`,
    acts: command !== null,
    reach: RUNS_EVERYWHERE,
  };
}

/** `<name> (shell for macOS) is what terminals and agents start in: <command>`. */
function shellLine(
  name: string,
  os: string | null,
  command: string | null,
): HeldCommandLine {
  const kind = os === null ? "shell" : `shell for ${os}`;
  const startsIn = command === null ? "" : `: ${command}`;
  return {
    name,
    clause: `(${kind}) is what terminals and agents start in${startsIn}`,
    acts: true,
    reach: `Once approved, every ${os === null ? "" : `${os} `}computer and sandbox running Personal uses it.`,
  };
}

/**
 * `<NAME> (variable) changes how Claude Code starts: <NAME>=<value>`; "changes
 * how programs start" when the program can't be named. An env setting's key
 * is `<harness>:<NAME>`, and the line names it by `<NAME>`.
 */
function variableLine(
  entry: EnvironmentReviewEntry,
  facts: ReviewEntryFacts,
): HeldCommandLine {
  const separator = entry.key.indexOf(":");
  const name =
    entry.kind === "env_override" && separator >= 0
      ? entry.key.slice(separator + 1)
      : entry.key;
  const program = facts.harness === null ? null : harnessLabel(facts.harness);
  const changes =
    program === null
      ? "changes how programs start"
      : `changes how ${program} starts`;
  const assignment = facts.value === null ? "" : `: ${name}=${facts.value}`;
  return {
    name,
    clause: `(variable) ${changes}${assignment}`,
    acts: true,
    reach: `Once approved, ${EVERYWHERE} starts ${program ?? "programs"} with it.`,
  };
}

export interface HeldItemsGroup {
  readonly hostId: string | null;
  readonly entries: readonly EnvironmentReviewEntry[];
}

export function heldItemsGroupedByHost(
  entries: readonly EnvironmentReviewEntry[],
): readonly HeldItemsGroup[] {
  const order: string[] = [];
  const groups = new Map<string, EnvironmentReviewEntry[]>();
  for (const entry of heldReviewEntries(entries)) {
    const key = entry.hostId ?? "";
    const existing = groups.get(key);
    if (existing === undefined) {
      order.push(key);
      groups.set(key, [entry]);
    } else {
      existing.push(entry);
    }
  }
  return order.map((key) => ({
    hostId: key.length === 0 ? null : key,
    entries: groups.get(key) ?? [],
  }));
}
