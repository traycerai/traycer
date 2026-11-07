import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { z } from "zod";

// `readInstallToken` on a real pseudo-terminal. A fake terminal cannot show
// what the operating system's line discipline does with bytes that arrive
// before raw mode is on: it echoes them. So a child that calls the real
// `readInstallToken` runs on a pty that a python3 driver controls. The driver
// writes its input the moment the prompt is readable and reads back what the
// terminal printed and which modes it was in.

const run = promisify(execFile);

const DRIVER = join(import.meta.dirname, "pty-fixtures", "pty_driver.py");
const CHILD = join(
  import.meta.dirname,
  "pty-fixtures",
  "host-join-token-child.ts",
);

const RUNS = 10;
const TOKEN = "synthetic-review-token-0123456789";
const TOKEN_DIGEST = createHash("sha256").update(TOKEN).digest("hex");
const CTRL_C = "\u0003";
const CTRL_D = "\u0004";

const TerminalModes = z.object({ echo: z.boolean(), icanon: z.boolean() });
const PtyRuns = z.array(
  z.object({
    prompt_seen: z.boolean(),
    at_prompt: TerminalModes.nullable(),
    reported: z.boolean(),
    after_read: TerminalModes.nullable(),
    exit_code: z.number().nullable(),
    after_exit: TerminalModes.nullable(),
    timed_out: z.boolean(),
    output: z.string(),
  }),
);

const RAW = { echo: false, icanon: false };
const LINE_MODE = { echo: true, icanon: true };

/** Runs the child RUNS times on a fresh pty each time, typing `typed` at its prompt. */
async function typeAtPrompt(typed: string) {
  const { stdout } = await run(
    "python3",
    [
      DRIVER,
      JSON.stringify({
        command: ["bun", CHILD],
        payload_hex: Buffer.from(typed, "utf8").toString("hex"),
        runs: RUNS,
        timeout_seconds: 5,
      }),
    ],
    { timeout: 60_000 },
  );
  return PtyRuns.parse(JSON.parse(stdout));
}

describe.skipIf(process.platform === "win32")(
  "readInstallToken on a real terminal",
  () => {
    it.each([
      ["Enter", "\r"],
      ["Ctrl-D", CTRL_D],
    ])(
      "reads a token typed the moment the prompt shows, ended by %s, without echoing a byte of it",
      async (_name, ending) => {
        const runs = await typeAtPrompt(`${TOKEN}${ending}`);

        expect(
          runs.map((one) => ({
            // Raw before the prompt is readable: nothing typed can be echoed.
            atPrompt: one.at_prompt,
            echoedToken: one.output.includes(TOKEN),
            reported: one.output.includes(
              `READ length=${TOKEN.length} sha256=${TOKEN_DIGEST}`,
            ),
            afterRead: one.after_read,
            exitCode: one.exit_code,
            afterExit: one.after_exit,
            timedOut: one.timed_out,
          })),
        ).toEqual(
          Array.from({ length: RUNS }, () => ({
            atPrompt: RAW,
            echoedToken: false,
            reported: true,
            afterRead: LINE_MODE,
            exitCode: 0,
            afterExit: LINE_MODE,
            timedOut: false,
          })),
        );
      },
      60_000,
    );

    it("cancels on Ctrl-C typed the moment the prompt shows, leaving the terminal echoing again", async () => {
      const runs = await typeAtPrompt(`${TOKEN.slice(0, 10)}${CTRL_C}`);

      expect(
        runs.map((one) => ({
          atPrompt: one.at_prompt,
          echoedTyping: one.output.includes(TOKEN.slice(0, 10)),
          refused: one.output.includes("REFUSED host join: cancelled."),
          afterRead: one.after_read,
          exitCode: one.exit_code,
          afterExit: one.after_exit,
          timedOut: one.timed_out,
        })),
      ).toEqual(
        Array.from({ length: RUNS }, () => ({
          atPrompt: RAW,
          echoedTyping: false,
          refused: true,
          afterRead: LINE_MODE,
          exitCode: 1,
          afterExit: LINE_MODE,
          timedOut: false,
        })),
      );
    }, 60_000);
  },
);
