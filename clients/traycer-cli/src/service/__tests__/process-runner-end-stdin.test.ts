import { describe, expect, it } from "vitest";
import {
  ProcessTimeoutError,
  runCommand,
  type EndedStdinRunOptions,
} from "../process-runner";

// R3 §A: `endStdin: true` ends the child's stdin right after spawn. A real
// child reading stdin until `end` before printing anything proves it -
// without the end, the child's read() call never resolves and the run times
// out; with it, the child sees EOF immediately and exits quickly. Real
// process, real stdio (not a fake runner): the subject is `execFile`'s own
// stdin handle, which a fake cannot stand in for. Node, not schtasks, so
// this runs on every platform this suite runs on.
const READ_STDIN_UNTIL_END_SCRIPT = `
let chunks = [];
process.stdin.on("data", (c) => chunks.push(c));
process.stdin.on("end", () => {
  process.stdout.write("eof");
  process.exit(0);
});
`;

describe("runCommand: endStdin ends the child's stdin at spawn", () => {
  it("with endStdin: true, the child reading until EOF resolves well inside 5s", async () => {
    // `runCommand`'s own timeout is comfortably below vitest's 5s default
    // `testTimeout`, so a run that actually blocks on stdin fails this test
    // by timeout rather than hanging the suite.
    const options: EndedStdinRunOptions = {
      env: process.env,
      cwd: undefined,
      timeoutMs: 3_000,
      tolerateNonZeroExit: false,
      endStdin: true,
    };
    const result = await runCommand(
      process.execPath,
      ["-e", READ_STDIN_UNTIL_END_SCRIPT],
      options,
    );
    expect(result).toEqual({ stdout: "eof", stderr: "", exitCode: 0 });
  });

  it("control: without endStdin, the same child never sees EOF and the call times out", async () => {
    await expect(
      runCommand(process.execPath, ["-e", READ_STDIN_UNTIL_END_SCRIPT], {
        env: process.env,
        cwd: undefined,
        timeoutMs: 1_500,
        tolerateNonZeroExit: false,
      }),
    ).rejects.toBeInstanceOf(ProcessTimeoutError);
  });
});
