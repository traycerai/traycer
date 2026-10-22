import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

// Claude Code keeps durable scheduled tasks (`CronCreate` with a durable
// schedule) at `<project>/.claude/scheduled_tasks.json` as `{"tasks": [...]}`.
const scheduledTasksFileSchema = z.looseObject({
  tasks: z.array(z.unknown()),
});

/**
 * How many durable scheduled tasks a Claude session started in `cwd` will
 * run: `0` when the file does not exist, the length of its `tasks` list, or
 * `null` when the file cannot be read or does not hold a `tasks` list. A
 * `null` is reported to the host as "not reported", which keeps the agent:
 * a task the CLI could not read may still be due.
 */
export async function countClaudeScheduledTasks(
  cwd: string,
): Promise<number | null> {
  let raw: string;
  try {
    raw = await readFile(
      path.join(cwd, ".claude", "scheduled_tasks.json"),
      "utf8",
    );
  } catch (error) {
    return isMissingFile(error) ? 0 : null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const file = scheduledTasksFileSchema.safeParse(parsed);
  return file.success ? file.data.tasks.length : null;
}

function isMissingFile(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR")
  );
}
