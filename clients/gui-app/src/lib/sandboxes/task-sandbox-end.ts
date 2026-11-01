import type { TaskSandboxEnd } from "@traycer/protocol/host/task-host-summary";
import type {
  TaskSandboxEndedHost,
  TaskSandboxHost,
} from "@/hooks/epic/use-task-sandbox-end";
import { sandboxMemberName } from "@/lib/sandboxes/sandbox-row-lines";
import type { EndedSandboxHost } from "@/stores/sandboxes/ended-sandbox-hosts-store";

// Local time, as every sandbox row states it.
const endDate = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
});
const endTime = new Intl.DateTimeFormat("en-US", {
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

function taskSandboxEndCause(end: TaskSandboxEnd): string {
  if (end.actor !== null) return `by ${end.actor}`;
  switch (end.cause) {
    case "idle":
    case "burst-idle":
      return end.idleMinutes === null
        ? "after its idle period"
        : `after ${end.idleMinutes} idle minutes`;
    case "resting":
      return "after resting";
    case "day-30":
      return "after 30 days frozen";
    case "failure":
      return "after a failure";
    case "erasure":
      return "after account deletion";
    default:
      return "";
  }
}

/**
 * How a chat's sandbox ended, by one precedence: the task's end record, then
 * a destroy this device already saw. `null` while neither says it ended.
 */
export function chatSandboxEndOf(
  task: TaskSandboxHost,
  ended: EndedSandboxHost | null,
  viewerUserId: string | null,
): TaskSandboxEndedHost | null {
  if (task.kind === "ended") return task.ended;
  return ended === null ? null : taskEndOfEndedHost(ended, viewerUserId);
}

/**
 * A destroy this device already knows, as the task's end record will read it:
 * one sentence from the state change on. The server may refine the actor
 * (an agent's title for a member's name) and the time when its record lands.
 */
function taskEndOfEndedHost(
  ended: EndedSandboxHost,
  viewerUserId: string | null,
): TaskSandboxEndedHost {
  const member =
    ended.actor === null ? null : sandboxMemberName(ended.actor, viewerUserId);
  return {
    name: ended.name,
    end: {
      state: "destroyed",
      destroyedAt: ended.at,
      cause: ended.cause,
      actor: ended.cause === "verb" ? (member ?? "a member") : member,
      idleMinutes: ended.cause === "burst-idle" ? ended.idleMinutes : null,
    },
  };
}

/**
 * The same end and timestamp drive the footer and task-authorized Details.
 * `staysReadable` is `ChatSandboxViewer.staysReadable`: the file loss stands
 * alone wherever nothing shows the chat has a copy.
 */
export function taskSandboxEndLine(
  name: string,
  end: TaskSandboxEnd,
  staysReadable: boolean,
): string {
  const when = `${endDate.format(end.destroyedAt)} at ${endTime.format(end.destroyedAt)}`;
  const cause = taskSandboxEndCause(end);
  const after = cause.length > 0 ? ` ${cause}` : "";
  const gone = `${name} was destroyed on ${when}${after}. Its files are gone`;
  return staysReadable ? `${gone}; this chat stays readable.` : `${gone}.`;
}
