import type { TaskSandboxEnd } from "@traycer/protocol/host/task-host-summary";

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

/** The same end and timestamp drive the footer and task-authorized Details. */
export function taskSandboxEndLine(name: string, end: TaskSandboxEnd): string {
  const when = `${endDate.format(end.destroyedAt)} at ${endTime.format(end.destroyedAt)}`;
  const cause = taskSandboxEndCause(end);
  const after = cause.length > 0 ? ` ${cause}` : "";
  return `${name} was destroyed on ${when}${after}. Its files are gone; this chat stays readable.`;
}
