import type { TaskSandboxEnd } from "@traycer/protocol/host/task-host-summary";

const endDate = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  timeZone: "UTC",
});
const endTime = new Intl.DateTimeFormat("en-US", {
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
  timeZone: "UTC",
});

function taskSandboxEndCause(end: TaskSandboxEnd): string {
  if (end.actor !== null) return `by ${end.actor}`;
  switch (end.cause) {
    case "idle":
    case "burst-idle":
      return "after its idle period";
    case "resting":
      return "after its resting period";
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
  const by = end.actor === null ? "" : ` ${cause}`;
  const after = end.actor === null && cause.length > 0 ? ` ${cause}` : "";
  return `${name} was destroyed${by} on ${when}${after}. Its files are gone; this chat stays readable.`;
}
