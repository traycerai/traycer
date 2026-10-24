import { toast } from "sonner";
import type { HostSandboxState } from "@traycer/protocol/host/host-status";
import type { SandboxLifecycleVerb } from "@traycer/protocol/host/sandbox-control";
import type { SandboxVerbOutcome } from "@/hooks/sandboxes/use-sandbox-verb-mutation";
import {
  formatSandboxDate,
  type SandboxSessionReport,
} from "@/lib/sandboxes/sandbox-row-lines";
import { KEPT_UNTIL_YOU_DESTROY_IT } from "@/lib/sandboxes/sandbox-strings";

/** The sentences and helpers of `sandbox-confirm-dialogs.tsx`, kept apart so
 * that file exports components only. */

export const SANDBOX_SESSIONS_CAPTION =
  "Other sessions may also be interrupted.";

const MS_PER_MINUTE = 60_000;

const VERB_DONE: Record<SandboxLifecycleVerb, string> = {
  suspend: "Suspended",
  resume: "Resumed",
  stop: "Stopped",
  start: "Started",
};

const VERB_MOVING: Record<SandboxLifecycleVerb, string> = {
  suspend: "Suspending",
  resume: "Resuming",
  stop: "Stopping",
  start: "Starting",
};

/**
 * The verb whose done word names the state the row reached, which need not
 * be the one pressed: a suspend whose purge found the guest unreachable
 * lands `stopped`.
 */
function verbReached(
  pressed: SandboxLifecycleVerb,
  state: HostSandboxState | null,
): SandboxLifecycleVerb {
  switch (state) {
    case "suspended":
      return "suspend";
    case "stopped":
      return "stop";
    default:
      return pressed;
  }
}

/** Says where a lifecycle verb left the sandbox. */
export function toastSandboxVerbOutcome(
  verb: SandboxLifecycleVerb,
  outcome: SandboxVerbOutcome,
  name: string,
): void {
  if (outcome.kind === "settled") {
    toast.success(`${VERB_DONE[verbReached(verb, outcome.state)]} ${name}`);
  } else if (outcome.kind === "moving") {
    toast.info(`${VERB_MOVING[verb]} ${name}…`);
  }
}

/** The Destroy sentence's first clause, from the sessions count. */
export function sandboxDestroySessionsSentence(
  report: SandboxSessionReport,
  team: boolean,
): string {
  const others = team ? ", including other members' running agents." : ".";
  if (report.kind === "live") {
    const noun = report.count === 1 ? "session" : "sessions";
    return `Destroying ends ${report.count} running ${noun}${others}`;
  }
  return `Destroying ends every running session${others}`;
}

/**
 * What the typed confirmation still needs: `null` once the name matches, an
 * empty reason while nothing is typed (confirm disabled, no sentence), and
 * the instruction once something is typed.
 */
export function sandboxTypedNameReason(
  typed: string,
  name: string,
): string | null {
  if (typed.trim() === name) return null;
  return typed.length === 0 ? "" : `Type ${name} below to destroy it.`;
}

/** The resting period's preview: the date a save from now would set. */
export function sandboxRestingPreview(
  minutes: number | null,
  now: number,
): string {
  if (minutes === null) {
    return `${KEPT_UNTIL_YOU_DESTROY_IT}. Never applies to idle cleanup. Out-of-credit sandboxes are deleted after 30 days frozen`;
  }
  if (Number.isNaN(minutes)) return "";
  return `Destroyed on ${formatSandboxDate(now + minutes * MS_PER_MINUTE, true)} if it rests from now.`;
}
