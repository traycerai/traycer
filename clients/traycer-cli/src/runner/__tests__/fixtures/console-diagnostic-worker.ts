import { runCommand } from "../../runner";

// Worker for `json-stdout-console.test.ts`. A command whose body logs the way
// the shared client libraries do - `console.log` / `console.info` /
// `console.debug` - run through the REAL runner, in the output mode named by
// `WORKER_JSON` ("1" for `--json`).
//
// `runCommand` owns the exit, so nothing after it runs.
await runCommand(
  async (ctx) => {
    ctx.progress({
      stage: "probe",
      message: "probing",
      percent: null,
      bytes: null,
      totalBytes: null,
      workUnits: null,
    });
    console.log("[lib] log diagnostic");
    console.info("[lib] info diagnostic");
    console.debug("[lib] debug diagnostic");
    return { data: { ok: true }, human: "done", exitCode: 0 };
  },
  {
    json: process.env.WORKER_JSON === "1",
    quiet: false,
    noProgress: false,
    noBootstrap: true,
  },
);
