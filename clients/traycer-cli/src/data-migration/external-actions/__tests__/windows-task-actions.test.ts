import { readFile } from "node:fs/promises";
import { win32 } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  actionsInInverseOrder,
  fingerprintsEqual,
  type ExternalAction,
} from "@traycer/protocol/config/data-migration-contracts";
import { escapeXml } from "../../../service/escape-xml";
import { serviceLabelFor, windowsTaskName } from "../../../service/label";
import type { CliInvocation } from "../../../service/cli-binary";
import {
  buildWindowsHiddenHostLauncher,
  buildWindowsTaskActionForLauncher,
  windowsHiddenHostLauncherPath,
  windowsRedefinedTaskXml,
} from "../../../service/platforms/windows";
import type {
  ScheduledTaskXmlQuery,
  WindowsTaskVerbRunner,
} from "../../../service/platforms/windows-task-gate";
import { decodeImage, isExternalActionConflictError } from "../ledger";
import { reconcileExternalAction } from "../reconcile";
import {
  applyWindowsTask,
  canonicalTaskXml,
  observeWindowsTask,
  planWindowsTaskQuiesce,
  planWindowsTaskRelocation,
  setWindowsTaskActionDepsForTests,
  TaskXmlUnreadableError,
  withTaskSettingsEnabled,
  windowsTaskForwardSchema,
} from "../windows-task-actions";

const roots = vi.hoisted(() => ({
  source: "C:\\Users\\Zoë Q\\.traycer",
  destination: "D:\\Träycer Data",
}));

// The ownership gate logs a refusal through the CLI logger, whose file lives
// under the (mocked, Windows-shaped) data root: keep it off the disk.
vi.mock("../../../logger", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../logger")>();
  return { ...actual, createCliLogger: () => actual.noopLogger };
});

vi.mock("@traycer/protocol/config/data-root", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@traycer/protocol/config/data-root")>();
  return { ...actual, traycerDataRoot: () => roots.source };
});

const SOURCE = roots.source;
const DESTINATION = roots.destination;
const CALLER_SID = "S-1-5-21-1111-2222-3333-1001";
const OTHER_SID = "S-1-5-21-1111-2222-3333-1002";

const label = serviceLabelFor("production");
const TASK = windowsTaskName(label);

const SOURCE_CLI = win32.join(SOURCE, "cli", "bin", "traycer.exe");
const DESTINATION_CLI = win32.join(DESTINATION, "cli", "bin", "traycer.exe");

/** The launcher location below `root`, whatever the host platform's separator. */
function launcherUnder(root: string): string {
  const launcher = windowsHiddenHostLauncherPath(label);
  const relative = launcher.slice(SOURCE.length + 1).split(/[\\/]/u);
  return win32.join(root, ...relative);
}

type TaskShape = {
  readonly sid: string;
  readonly enabled: boolean;
  readonly command: string;
  readonly argumentsLine: string;
  readonly trigger: string;
  readonly extraSetting: string;
};

function taskXml(shape: Partial<TaskShape>): string {
  const launcher = buildWindowsTaskActionForLauncher(launcherUnder(SOURCE));
  const full: TaskShape = {
    sid: CALLER_SID,
    enabled: true,
    command: launcher.command,
    argumentsLine: launcher.argumentsLine,
    trigger: "<LogonTrigger><Enabled>true</Enabled></LogonTrigger>",
    extraSetting: "<Priority>4</Priority>",
    ...shape,
  };
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>Traycer Host – Zoë</Description>
  </RegistrationInfo>
  <Triggers>
    ${full.trigger}
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>${full.sid}</UserId>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <Enabled>${full.enabled ? "true" : "false"}</Enabled>
    ${full.extraSetting}
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${escapeXml(full.command)}</Command>
      <Arguments>${escapeXml(full.argumentsLine)}</Arguments>
    </Exec>
  </Actions>
</Task>
`;
}

/** Everything but the `<Exec>` element: what a retarget must keep byte for byte. */
function withoutExec(xml: string): string {
  return xml.replace(/<Exec>[\s\S]*?<\/Exec>/u, "<Exec/>");
}

/**
 * The task-level Settings as Windows Task Scheduler read them back (measured
 * on Server 2022): no `<Enabled>` for an enabled task.
 */
const MEASURED_SETTINGS = [
  "<DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>",
  "<StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>",
  "<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>",
  "<Hidden>true</Hidden>",
  "<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>",
  "<Priority>4</Priority>",
  "<RestartOnFailure><Count>3</Count><Interval>PT1M</Interval></RestartOnFailure>",
  "<StartWhenAvailable>true</StartWhenAvailable>",
  "<IdleSettings><StopOnIdleEnd>false</StopOnIdleEnd><RestartOnIdle>false</RestartOnIdle></IdleSettings>",
  "<UseUnifiedSchedulingEngine>true</UseUnifiedSchedulingEngine>",
];

/** `MEASURED_SETTINGS` with `enabled` (possibly empty) inserted before the element at index `at`. */
function measuredSettings(enabled: string, at: number): string {
  return [
    ...MEASURED_SETTINGS.slice(0, at),
    enabled,
    ...MEASURED_SETTINGS.slice(at),
  ].join("");
}

/** The measured elements `taskXml` does not already write itself (it writes the MultipleInstancesPolicy). */
const MEASURED_EXTRA_SETTINGS = MEASURED_SETTINGS.filter(
  (element) => !element.startsWith("<MultipleInstancesPolicy>"),
).join("");

/** Where the scheduler read an explicit `false` back: right after StopIfGoingOnBatteries. */
const AFTER_STOP_ON_BATTERIES = 2;

type DefinitionParts = {
  readonly version: string;
  readonly description: string;
  readonly trigger: string;
  readonly userId: string;
  readonly logonType: string;
  readonly command: string;
  readonly argumentsLine: string;
  readonly settings: string;
};

const MEASURED_ARGUMENTS =
  "&quot;//B&quot; &quot;//Nologo&quot; &quot;C:\\rcverify\\w718\\task-dest\\cli\\dev\\host-start-hidden.vbs&quot;";

/** A whole definition built from the measured shapes, parts spliced in verbatim. */
function definition(overrides: Partial<DefinitionParts>): string {
  const full: DefinitionParts = {
    version: "1.4",
    description: "Traycer Host",
    trigger: "<LogonTrigger><Enabled>true</Enabled></LogonTrigger>",
    userId: CALLER_SID,
    logonType: "InteractiveToken",
    command: "C:\\Windows\\System32\\wscript.exe",
    argumentsLine: MEASURED_ARGUMENTS,
    settings: measuredSettings("", MEASURED_SETTINGS.length),
    ...overrides,
  };
  return `<Task version="${full.version}" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>${full.description}</Description>
  </RegistrationInfo>
  <Triggers>
    ${full.trigger}
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>${full.userId}</UserId>
      <LogonType>${full.logonType}</LogonType>
    </Principal>
  </Principals>
  <Settings>${full.settings}</Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${full.command}</Command>
      <Arguments>${full.argumentsLine}</Arguments>
    </Exec>
  </Actions>
</Task>`;
}

/**
 * What Task Scheduler stores for a definition written through `/Create`
 * (measured): a task-level `<Enabled>true</Enabled>` dropped, an explicit
 * `false` moved to just after StopIfGoingOnBatteries, `&quot;` read back as
 * `"`, and `\r\r\n` line endings. Idempotent.
 */
function storedByWindows(xml: string): string {
  const settings = /<Settings>([\s\S]*?)<\/Settings>/u.exec(xml);
  let body = xml;
  if (settings !== null) {
    const inner = settings[1] ?? "";
    const enabled = /<Enabled>\s*([^<]*?)\s*<\/Enabled>/u.exec(inner)?.[1];
    const without = inner.replace(/<Enabled>[^<]*<\/Enabled>/u, "");
    const stopEnd = "</StopIfGoingOnBatteries>";
    const placed =
      enabled === "false"
        ? without.replace(stopEnd, `${stopEnd}<Enabled>false</Enabled>`)
        : without;
    body = `${xml.slice(0, settings.index)}<Settings>${placed}</Settings>${xml.slice(settings.index + settings[0].length)}`;
  }
  return body.replace(/&quot;/gu, '"').replace(/\r*\n/gu, "\r\r\n");
}

/** How a staged `/Create` is stored: as written, unless a test models the scheduler. */
let store: (xml: string) => string = (xml) => xml;

const scheduler = new Map<string, string>();
const regularFiles = new Set<string>();
let predictedCli: () => Promise<CliInvocation>;
const created: { readonly args: readonly string[] }[] = [];

function query(taskName: string): Promise<ScheduledTaskXmlQuery> {
  const xml = scheduler.get(taskName);
  return Promise.resolve(
    xml === undefined ? { kind: "absent" } : { kind: "xml", xml },
  );
}

const run: WindowsTaskVerbRunner = async (command, args) => {
  if (command !== "schtasks" || args[0] !== "/Create") {
    throw new Error(`unexpected command ${command} ${args.join(" ")}`);
  }
  created.push({ args });
  const name = args[args.indexOf("/TN") + 1] ?? "";
  const xmlPath = args[args.indexOf("/XML") + 1] ?? "";
  if (scheduler.has(name) && !args.includes("/F")) {
    throw new Error("task exists");
  }
  const bytes = await readFile(xmlPath);
  // The staged file is UTF-16LE with a BOM, as `schtasks /XML` expects.
  expect(bytes[0]).toBe(0xff);
  expect(bytes[1]).toBe(0xfe);
  scheduler.set(name, store(bytes.toString("utf16le").replace(/^\uFEFF/u, "")));
  return { stdout: "", stderr: "", exitCode: 0 };
};

function installDeps(
  queryTaskXml: (taskName: string) => Promise<ScheduledTaskXmlQuery>,
): void {
  setWindowsTaskActionDepsForTests({
    queryTaskXml,
    predictCli: () => predictedCli(),
    ownership: {
      queryTaskXml,
      callerSid: () => CALLER_SID,
      resolveAccountSid: () => Promise.resolve(null),
      taskHiddenFromCaller: () => Promise.resolve(false),
    },
    run,
    isRegularFile: (path) => Promise.resolve(regularFiles.has(path)),
  });
}

beforeEach(() => {
  scheduler.clear();
  regularFiles.clear();
  created.length = 0;
  store = (xml) => xml;
  regularFiles.add(DESTINATION_CLI);
  predictedCli = () => Promise.resolve({ command: SOURCE_CLI, args: [] });
  installDeps(query);
});

afterEach(() => {
  setWindowsTaskActionDepsForTests(null);
});

function forwardOf(action: ExternalAction) {
  return windowsTaskForwardSchema.parse(action.forward);
}

function taskActions(actions: readonly ExternalAction[]): ExternalAction[] {
  return actions.filter(
    (action) => windowsTaskForwardSchema.safeParse(action.forward).success,
  );
}

describe("canonicalTaskXml", () => {
  const base = `<Task><A>x</A><B> keep  inner </B></Task>`;

  it("ignores BOM, XML declaration, line endings and inter-element whitespace", () => {
    const noisy = `\uFEFF<?xml version="1.0" encoding="UTF-16"?>\r\n<Task>\r\n  <A>x</A>\r\n\r\n  <B> keep  inner </B>\r\n</Task>\r\n`;
    expect(canonicalTaskXml(noisy)).toBe(canonicalTaskXml(base));
  });

  it("keeps text inside elements exactly", () => {
    expect(canonicalTaskXml(base)).not.toBe(
      canonicalTaskXml(`<Task><A>x</A><B>keep inner</B></Task>`),
    );
    expect(canonicalTaskXml(base)).not.toBe(
      canonicalTaskXml(`<Task><A>y</A><B> keep  inner </B></Task>`),
    );
  });

  const atEnd = MEASURED_SETTINGS.length;
  const literalArguments = MEASURED_ARGUMENTS.replace(/&quot;/gu, '"');
  const bare = definition({});
  const equalPairs: [string, string, string][] = [
    [
      "an omitted task Enabled equals an explicit true",
      bare,
      definition({ settings: measuredSettings("<Enabled>true</Enabled>", 0) }),
    ],
    [
      "an omitted task Enabled equals an explicit 1 at the end",
      bare,
      definition({ settings: measuredSettings("<Enabled>1</Enabled>", atEnd) }),
    ],
    [
      "a false at the end of Settings equals one after StopIfGoingOnBatteries",
      definition({
        settings: measuredSettings("<Enabled>false</Enabled>", atEnd),
      }),
      definition({
        settings: measuredSettings(
          "<Enabled>false</Enabled>",
          AFTER_STOP_ON_BATTERIES,
        ),
      }),
    ],
    [
      "a 0 equals a false",
      definition({ settings: measuredSettings("<Enabled>0</Enabled>", atEnd) }),
      definition({
        settings: measuredSettings(
          "<Enabled>false</Enabled>",
          AFTER_STOP_ON_BATTERIES,
        ),
      }),
    ],
    [
      "a false with whitespace around it equals a bare false",
      definition({
        settings: measuredSettings("<Enabled> false </Enabled>", 0),
      }),
      definition({
        settings: measuredSettings(
          "<Enabled>false</Enabled>",
          AFTER_STOP_ON_BATTERIES,
        ),
      }),
    ],
    [
      "the scheduler's &quot; arguments equal the literal-quote arguments",
      bare,
      definition({ argumentsLine: literalArguments }),
    ],
    [
      "&#34; and &#x22; equal a literal quote",
      definition({ argumentsLine: "&#34;a&#x22; b" }),
      definition({ argumentsLine: '"a" b' }),
    ],
    [
      "&apos; equals a literal apostrophe",
      definition({ argumentsLine: "&apos;a&apos;" }),
      definition({ argumentsLine: "'a'" }),
    ],
    [
      "\\r\\r\\n, the UTF-16 declaration and a BOM are only serialization",
      bare,
      `\uFEFF<?xml version="1.0" encoding="UTF-16"?>\r\r\n${bare.replace(/\n/gu, "\r\r\n")}\r\r\n`,
    ],
    [
      "a non-ASCII path in Command and Arguments survives the scheduler's re-serialization",
      definition({
        command: "D:\\q8t\\p4\\Tr\u00E1ycer Data m\\bin\\traycer.exe",
        argumentsLine: "&quot;D:\\q8t\\p4\\Tr\u00E1ycer Data m&quot; host run",
      }),
      `\uFEFF<?xml version="1.0" encoding="UTF-16"?>\r\r\n${storedByWindows(
        definition({
          command: "D:\\q8t\\p4\\Tr\u00E1ycer Data m\\bin\\traycer.exe",
          argumentsLine:
            "&quot;D:\\q8t\\p4\\Tr\u00E1ycer Data m&quot; host run",
        }),
      )}`,
    ],
  ];
  it.each(equalPairs)("%s", (_name, left, right) => {
    expect(canonicalTaskXml(left)).toBe(canonicalTaskXml(right));
  });

  const disabled = measuredSettings(
    "<Enabled>false</Enabled>",
    AFTER_STOP_ON_BATTERIES,
  );
  const differentPairs: [string, string, string][] = [
    [
      "an enabled task and a disabled one",
      bare,
      definition({ settings: disabled }),
    ],
    [
      "a trigger Enabled false and an omitted one",
      definition({
        trigger: "<LogonTrigger><Enabled>false</Enabled></LogonTrigger>",
      }),
      definition({ trigger: "<LogonTrigger></LogonTrigger>" }),
    ],
    [
      "a trigger Enabled true and an omitted one",
      bare,
      definition({ trigger: "<LogonTrigger></LogonTrigger>" }),
    ],
    ["a different principal UserId", bare, definition({ userId: OTHER_SID })],
    ["a different principal LogonType", bare, definition({ logonType: "S4U" })],
    [
      "a different Command",
      bare,
      definition({ command: "C:\\Other\\wscript.exe" }),
    ],
    [
      "different Arguments",
      bare,
      definition({ argumentsLine: "&quot;//B&quot;" }),
    ],
    [
      "a different Description",
      bare,
      definition({ description: "Something else" }),
    ],
    [
      "Hidden and Priority swapped",
      bare,
      definition({
        settings: MEASURED_SETTINGS.map((element) =>
          element === "<Hidden>true</Hidden>"
            ? "<Priority>4</Priority>"
            : element === "<Priority>4</Priority>"
              ? "<Hidden>true</Hidden>"
              : element,
        ).join(""),
      }),
    ],
    ["a different attribute value", bare, definition({ version: "1.3" })],
    [
      "&amp;lt; and &lt; (references are decoded once)",
      definition({ description: "a &amp;lt; b" }),
      definition({ description: "a &lt; b" }),
    ],
    [
      "text with and without surrounding whitespace",
      definition({ description: " Traycer Host " }),
      bare,
    ],
  ];
  it.each(differentPairs)("keeps %s apart", (_name, left, right) => {
    expect(canonicalTaskXml(left)).not.toBe(canonicalTaskXml(right));
  });

  const unreadable: [string, string][] = [
    ["a bare &", definition({ description: "a & b" })],
    ["an unknown reference", definition({ description: "a &bogus; b" })],
    ["an invalid numeric reference", definition({ description: "a &#0; b" })],
    ["a comment", definition({ description: "<!-- note -->" })],
    ["CDATA", definition({ description: "<![CDATA[note]]>" })],
    ["a mis-nested close tag", "<Task><B></A></Task>"],
    ["an unclosed root", "<Task><A>x</A>"],
    ["text outside the root", "<Task><A>x</A></Task>trailing"],
    [
      "two Settings under Task",
      "<Task><Settings><Priority>4</Priority></Settings><Settings><Priority>5</Priority></Settings></Task>",
    ],
    [
      "two Enabled directly under Settings",
      "<Task><Settings><Enabled>true</Enabled><Enabled>false</Enabled></Settings></Task>",
    ],
    [
      "a non-boolean Enabled",
      "<Task><Settings><Enabled>maybe</Enabled></Settings></Task>",
    ],
    [
      "an empty Enabled element",
      "<Task><Settings><Enabled/></Settings></Task>",
    ],
  ];
  it.each(unreadable)(
    "refuses %s with TaskXmlUnreadableError",
    (_name, xml) => {
      expect(() => canonicalTaskXml(xml)).toThrow(TaskXmlUnreadableError);
    },
  );
});

describe("withTaskSettingsEnabled", () => {
  it("replaces an existing task-level Enabled", () => {
    const xml = taskXml({ enabled: true });
    const disabled = withTaskSettingsEnabled(xml, false);
    expect(disabled).not.toBeNull();
    expect(disabled).toContain("<Enabled>false</Enabled>");
    // The trigger's own <Enabled> is not the task-level switch.
    expect(disabled).toContain(
      "<LogonTrigger><Enabled>true</Enabled></LogonTrigger>",
    );
    expect(withTaskSettingsEnabled(disabled ?? "", true)).toBe(xml);
  });

  it("inserts the element when Settings has none", () => {
    const xml = "<Task><Settings><Priority>4</Priority></Settings></Task>";
    expect(withTaskSettingsEnabled(xml, false)).toBe(
      "<Task><Settings><Priority>4</Priority><Enabled>false</Enabled></Settings></Task>",
    );
  });

  it("returns null without a Settings element", () => {
    expect(withTaskSettingsEnabled("<Task/>", false)).toBeNull();
  });
});

describe("planWindowsTaskQuiesce", () => {
  it("plans a disable for an enabled owned task, touching only the task-level switch", async () => {
    const before = taskXml({ enabled: true });
    scheduler.set(TASK, before);
    const plan = await planWindowsTaskQuiesce({ labels: [label] });
    expect(plan.blockers).toEqual([]);
    expect(plan.actions).toHaveLength(1);
    const action = plan.actions[0];
    expect(action?.kind).toBe("service-registration");
    expect(action?.state).toBe("planned");
    const forward = forwardOf(action as ExternalAction);
    expect(forward).toMatchObject({
      stage: "quiesce",
      step: "disable",
      taskName: TASK,
    });
    expect(forward.xml).toBe(withTaskSettingsEnabled(before, false));
    expect(action?.inverse).toMatchObject({ xml: before });
  });

  it("plans nothing for an already-disabled task", async () => {
    scheduler.set(TASK, taskXml({ enabled: false }));
    expect(await planWindowsTaskQuiesce({ labels: [label] })).toEqual({
      actions: [],
      blockers: [],
    });
  });

  it("plans nothing for an absent task", async () => {
    expect(await planWindowsTaskQuiesce({ labels: [label] })).toEqual({
      actions: [],
      blockers: [],
    });
  });

  it("blocks a task owned by another account, with no action", async () => {
    scheduler.set(TASK, taskXml({ sid: OTHER_SID }));
    const plan = await planWindowsTaskQuiesce({ labels: [label] });
    expect(plan.actions).toEqual([]);
    expect(plan.blockers).toHaveLength(1);
    expect(plan.blockers[0]).toMatchObject({
      code: "task-not-owned",
      object: TASK,
    });
  });

  it("blocks a task whose enabled state cannot be read", async () => {
    scheduler.set(
      TASK,
      taskXml({}).replace(
        "<Enabled>true</Enabled>\n    <Priority>",
        "<Enabled>maybe</Enabled>\n    <Priority>",
      ),
    );
    const plan = await planWindowsTaskQuiesce({ labels: [label] });
    expect(plan.actions).toEqual([]);
    expect(plan.blockers[0]?.code).toBe("task-unrecognized");
  });

  it("disables through the gate and rolls back to the exact before definition", async () => {
    const before = taskXml({ enabled: true });
    scheduler.set(TASK, before);
    const plan = await planWindowsTaskQuiesce({ labels: [label] });
    const planned = plan.actions[0] as ExternalAction;
    const applied = await reconcileExternalAction(planned, "forward", [
      planned,
    ]);
    expect(applied.kind).toBe("settled");
    if (applied.kind !== "settled") return;
    expect(applied.action.state).toBe("applied");
    expect(canonicalTaskXml(scheduler.get(TASK) ?? "")).toBe(
      canonicalTaskXml(withTaskSettingsEnabled(before, false) ?? ""),
    );
    expect(created).toHaveLength(1);
    expect(created[0]?.args).toContain("/F");

    const inverted = await reconcileExternalAction(applied.action, "inverse", [
      applied.action,
    ]);
    expect(inverted.kind).toBe("settled");
    expect(scheduler.get(TASK)).toBe(before);
  });
});

describe("planWindowsTaskRelocation", () => {
  const disabledXml = (): string => taskXml({ enabled: false });
  const relocate = (ledger: readonly ExternalAction[]) =>
    planWindowsTaskRelocation({
      labels: [label],
      roots: { sourceRoot: SOURCE, destinationRoot: DESTINATION },
      ledger,
    });

  async function appliedQuiesceDisable(): Promise<ExternalAction> {
    scheduler.set(TASK, taskXml({ enabled: true }));
    const planned = (await planWindowsTaskQuiesce({ labels: [label] }))
      .actions[0] as ExternalAction;
    const outcome = await reconcileExternalAction(planned, "forward", [
      planned,
    ]);
    if (outcome.kind !== "settled") throw new Error("quiesce did not apply");
    return outcome.action;
  }

  it("plans the destination launcher and a retarget that keeps everything but the Exec", async () => {
    const before = disabledXml();
    scheduler.set(TASK, before);
    const plan = await relocate([]);
    expect(plan.blockers).toEqual([]);
    expect(plan.actions.map((action) => action.kind)).toEqual([
      "service-registration",
      "service-registration",
    ]);
    const [launcher, retarget] = plan.actions as [
      ExternalAction,
      ExternalAction,
    ];

    // Launcher file: BOM + the launcher for the DESTINATION CLI.
    const destinationLauncher = launcherUnder(DESTINATION);
    expect(launcher.object).toBe(destinationLauncher);
    const image = decodeImage(
      (launcher.forward as { image: string | null }).image,
    );
    expect(image).not.toBeNull();
    const text = (image as Buffer).toString("utf16le");
    expect(text.startsWith("\uFEFF")).toBe(true);
    expect(text).toBe(
      `\uFEFF${buildWindowsHiddenHostLauncher({ command: DESTINATION_CLI, args: [] }, label)}`,
    );
    expect(text).toContain(DESTINATION_CLI);
    expect(text).toContain("adoption-nonce");
    expect(text).not.toContain(SOURCE);
    expect(launcher.before).toEqual({ kind: "absent" });

    // Retarget: the action names the destination launcher; the task stays disabled.
    const forward = forwardOf(retarget);
    expect(forward).toMatchObject({ stage: "prepare", step: "retarget" });
    expect(forward.xml).toBe(
      windowsRedefinedTaskXml(
        before,
        buildWindowsTaskActionForLauncher(destinationLauncher),
      ),
    );
    expect(forward.xml).toContain("<Enabled>false</Enabled>");
    expect(forward.xml).toContain(
      escapeXml(
        buildWindowsTaskActionForLauncher(destinationLauncher).argumentsLine,
      ),
    );
    expect(forward.xml).not.toContain(SOURCE);
    expect(withoutExec(forward.xml)).toBe(withoutExec(before));
    expect(retarget.inverse).toMatchObject({ xml: before });
  });

  it("keeps an npm-style CLI outside the data root", async () => {
    const npmCli = "C:\\Program Files\\nodejs\\traycer.cmd";
    predictedCli = () => Promise.resolve({ command: npmCli, args: [] });
    regularFiles.add(npmCli);
    scheduler.set(TASK, disabledXml());
    const plan = await relocate([]);
    expect(plan.blockers).toEqual([]);
    const image = decodeImage(
      (plan.actions[0]?.forward as { image: string | null }).image,
    );
    expect((image as Buffer).toString("utf16le")).toContain(npmCli);
  });

  it("adds an enable action only when the ledger holds an applied quiesce disable", async () => {
    const disable = await appliedQuiesceDisable();
    const plan = await relocate([disable]);
    expect(plan.blockers).toEqual([]);
    const steps = taskActions(plan.actions).map(
      (action) => forwardOf(action).step,
    );
    expect(steps).toEqual(["retarget", "enable"]);
    const enable = taskActions(plan.actions)[1] as ExternalAction;
    expect(forwardOf(enable).stage).toBe("activate");
    expect(forwardOf(enable).xml).toContain("<Enabled>true</Enabled>");
    // The enable builds on the retargeted definition.
    expect(forwardOf(enable).xml).toContain(
      escapeXml(
        buildWindowsTaskActionForLauncher(launcherUnder(DESTINATION))
          .argumentsLine,
      ),
    );
    expect(enable.inverse).toMatchObject({
      xml: forwardOf(taskActions(plan.actions)[0] as ExternalAction).xml,
    });
  });

  it("leaves a task the user had disabled disabled (no enable action)", async () => {
    scheduler.set(TASK, disabledXml());
    const plan = await relocate([]);
    expect(
      taskActions(plan.actions).map((action) => forwardOf(action).step),
    ).toEqual(["retarget"]);
  });

  it("ignores a planned-but-unapplied disable and a disable for another task", async () => {
    const disable = await appliedQuiesceDisable();
    const planned: ExternalAction = { ...disable, state: "planned" };
    expect(
      taskActions((await relocate([planned])).actions).map(
        (a) => forwardOf(a).step,
      ),
    ).toEqual(["retarget"]);
    const elsewhere: ExternalAction = {
      ...disable,
      forward: {
        ...(disable.forward as object),
        taskName: "\\Traycer\\Host-Staging",
      },
    };
    expect(
      taskActions((await relocate([elsewhere])).actions).map(
        (a) => forwardOf(a).step,
      ),
    ).toEqual(["retarget"]);
  });

  it("blocks a task that is still enabled", async () => {
    scheduler.set(TASK, taskXml({ enabled: true }));
    const plan = await relocate([]);
    expect(plan.actions).toEqual([]);
    expect(plan.blockers[0]?.code).toBe("task-enabled-during-migration");
  });

  it("blocks a task owned by another account", async () => {
    scheduler.set(TASK, taskXml({ enabled: false, sid: OTHER_SID }));
    const plan = await relocate([]);
    expect(plan.actions).toEqual([]);
    expect(plan.blockers[0]).toMatchObject({
      code: "task-not-owned",
      object: TASK,
    });
  });

  it("blocks an action that names the source root in a non-launcher form", async () => {
    scheduler.set(
      TASK,
      taskXml({
        enabled: false,
        command: SOURCE_CLI,
        argumentsLine: "host start",
      }),
    );
    const plan = await relocate([]);
    expect(plan.actions).toEqual([]);
    expect(plan.blockers[0]).toMatchObject({
      code: "task-action-not-current",
      object: TASK,
    });
  });

  it("plans nothing for a task that does not reference the source root", async () => {
    scheduler.set(
      TASK,
      taskXml({
        enabled: false,
        command: "C:\\Program Files\\nodejs\\traycer.cmd",
        argumentsLine: "host start",
      }),
    );
    expect(await relocate([])).toEqual({ actions: [], blockers: [] });
  });

  it("blocks when the destination CLI is not a file", async () => {
    regularFiles.clear();
    scheduler.set(TASK, disabledXml());
    const plan = await relocate([]);
    expect(plan.actions).toEqual([]);
    expect(plan.blockers[0]).toMatchObject({
      code: "destination-cli-missing",
      object: DESTINATION_CLI,
    });
  });

  it("blocks when the CLI would still live inside the source root", async () => {
    // A CLI under a different spelling of the source root is rebased; one that
    // cannot be rebased out of the source (junction-style) is refused.
    predictedCli = () => Promise.reject(new Error("no cli"));
    scheduler.set(TASK, disabledXml());
    const plan = await relocate([]);
    expect(plan.blockers[0]?.code).toBe("destination-cli-unresolved");
  });

  it("plans nothing for an absent task", async () => {
    expect(await relocate([])).toEqual({ actions: [], blockers: [] });
  });
});

describe("applying a planned relocation", () => {
  async function planned(
    ledger: readonly ExternalAction[],
  ): Promise<ExternalAction[]> {
    const plan = await planWindowsTaskRelocation({
      labels: [label],
      roots: { sourceRoot: SOURCE, destinationRoot: DESTINATION },
      ledger,
    });
    expect(plan.blockers).toEqual([]);
    return taskActions(plan.actions);
  }

  it("retargets through the gate, then rolls back to the exact before XML", async () => {
    const before = taskXml({ enabled: false });
    scheduler.set(TASK, before);
    const [retarget] = await planned([]);
    const applied = await reconcileExternalAction(
      retarget as ExternalAction,
      "forward",
      [retarget as ExternalAction],
    );
    expect(applied.kind).toBe("settled");
    if (applied.kind !== "settled") return;
    expect(applied.action.state).toBe("applied");
    expect(withoutExec(scheduler.get(TASK) ?? "")).toBe(withoutExec(before));
    expect(scheduler.get(TASK)).toContain(DESTINATION);

    const back = await reconcileExternalAction(applied.action, "inverse", [
      applied.action,
    ]);
    expect(back.kind).toBe("settled");
    expect(scheduler.get(TASK)).toBe(before);
  });

  it("treats a crash after the effect, before the receipt, as record-applied with no write", async () => {
    scheduler.set(TASK, taskXml({ enabled: false }));
    const [retarget] = await planned([]);
    await applyWindowsTask(retarget as ExternalAction);
    created.length = 0;
    const outcome = await reconcileExternalAction(
      retarget as ExternalAction,
      "forward",
      [retarget as ExternalAction],
    );
    expect(outcome.kind).toBe("settled");
    if (outcome.kind !== "settled") return;
    expect(outcome.decision).toBe("record-applied");
    expect(created).toHaveLength(0);
  });

  it("returns a conflict and leaves the scheduler alone when a trigger changed after planning", async () => {
    scheduler.set(TASK, taskXml({ enabled: false }));
    const [retarget] = await planned([]);
    const edited = taskXml({
      enabled: false,
      trigger:
        "<LogonTrigger><Enabled>true</Enabled><Delay>PT5M</Delay></LogonTrigger>",
    });
    scheduler.set(TASK, edited);
    const outcome = await reconcileExternalAction(
      retarget as ExternalAction,
      "forward",
      [retarget as ExternalAction],
    );
    expect(outcome.kind).toBe("conflict");
    expect(scheduler.get(TASK)).toBe(edited);
    expect(created).toHaveLength(0);
  });

  it("the write itself is a compare-and-set: a definition that changed since planning is refused", async () => {
    scheduler.set(TASK, taskXml({ enabled: false }));
    const [retarget] = await planned([]);
    const edited = taskXml({
      enabled: false,
      extraSetting: "<Priority>7</Priority>",
    });
    scheduler.set(TASK, edited);
    const failure = await applyWindowsTask(retarget as ExternalAction).then(
      () => null,
      (cause: unknown) => cause,
    );
    expect(isExternalActionConflictError(failure)).toBe(true);
    expect(scheduler.get(TASK)).toBe(edited);
    expect(created).toHaveLength(0);
  });

  it("refuses to write a task that turned out to belong to another account", async () => {
    scheduler.set(TASK, taskXml({ enabled: false }));
    const [retarget] = await planned([]);
    const foreign = taskXml({ enabled: false, sid: OTHER_SID });
    scheduler.set(TASK, foreign);
    const failure = await applyWindowsTask(retarget as ExternalAction).then(
      () => null,
      (cause: unknown) => cause,
    );
    expect(failure).not.toBeNull();
    expect(scheduler.get(TASK)).toBe(foreign);
    expect(created).toHaveLength(0);
  });

  it("runs quiesce -> retarget -> enable forward and restores the original in reverse order", async () => {
    const original = taskXml({ enabled: true });
    scheduler.set(TASK, original);
    const quiesce = (await planWindowsTaskQuiesce({ labels: [label] }))
      .actions[0] as ExternalAction;
    const disabled = await reconcileExternalAction(quiesce, "forward", [
      quiesce,
    ]);
    if (disabled.kind !== "settled") throw new Error("quiesce failed");
    const [retarget, enable] = await planned([disabled.action]);
    let ledger: ExternalAction[] = [
      disabled.action,
      retarget as ExternalAction,
      enable as ExternalAction,
    ];
    const settle = (next: ExternalAction): void => {
      ledger = ledger.map((entry) => (entry.id === next.id ? next : entry));
    };
    for (const action of [retarget, enable] as ExternalAction[]) {
      const outcome = await reconcileExternalAction(action, "forward", ledger);
      if (outcome.kind !== "settled")
        throw new Error(`${action.id} did not settle`);
      settle(outcome.action);
    }
    const finalXml = scheduler.get(TASK) ?? "";
    expect(finalXml).toContain("<Enabled>true</Enabled>");
    expect(finalXml).toContain(DESTINATION);

    for (const action of actionsInInverseOrder(ledger)) {
      const current = ledger.find(
        (entry) => entry.id === action.id,
      ) as ExternalAction;
      const outcome = await reconcileExternalAction(current, "inverse", ledger);
      if (outcome.kind !== "settled")
        throw new Error(`${action.id} did not roll back`);
      settle(outcome.action);
    }
    expect(scheduler.get(TASK)).toBe(original);
  });
});

describe("against a scheduler that stores definitions the way Windows does", () => {
  beforeEach(() => {
    store = storedByWindows;
  });

  /** An owned task as the scheduler reads it back: an enabled one carries no task-level Enabled. */
  function storedTask(enabled: boolean): string {
    return storedByWindows(
      taskXml({ enabled, extraSetting: MEASURED_EXTRA_SETTINGS }),
    );
  }

  async function relocationActions(
    ledger: readonly ExternalAction[],
  ): Promise<ExternalAction[]> {
    const plan = await planWindowsTaskRelocation({
      labels: [label],
      roots: { sourceRoot: SOURCE, destinationRoot: DESTINATION },
      ledger,
    });
    expect(plan.blockers).toEqual([]);
    return taskActions(plan.actions);
  }

  const planners: [string, () => Promise<ExternalAction>][] = [
    [
      "disable",
      async () => {
        scheduler.set(TASK, storedTask(true));
        const plan = await planWindowsTaskQuiesce({ labels: [label] });
        return plan.actions[0] as ExternalAction;
      },
    ],
    [
      "retarget",
      async () => {
        scheduler.set(TASK, storedTask(false));
        return (await relocationActions([]))[0] as ExternalAction;
      },
    ],
  ];

  it("plans one disable for an enabled task whose read-back omits Enabled, and its after image is what the scheduler reads back", async () => {
    const stored = storedTask(true);
    expect(stored).not.toMatch(
      /<Settings>[\s\S]*<Enabled>[\s\S]*<\/Settings>/u,
    );
    scheduler.set(TASK, stored);
    const plan = await planWindowsTaskQuiesce({ labels: [label] });
    expect(plan.blockers).toEqual([]);
    expect(plan.actions).toHaveLength(1);
    const action = plan.actions[0] as ExternalAction;
    expect(forwardOf(action)).toMatchObject({
      stage: "quiesce",
      step: "disable",
    });

    await applyWindowsTask(action);
    expect(scheduler.get(TASK)).toContain(
      "<StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><Enabled>false</Enabled>",
    );
    expect(
      fingerprintsEqual(await observeWindowsTask(action), action.after),
    ).toBe(true);
  });

  it("settles quiesce -> retarget -> enable as applied and restores the original in reverse order", async () => {
    const original = storedTask(true);
    scheduler.set(TASK, original);
    const quiesce = (await planWindowsTaskQuiesce({ labels: [label] }))
      .actions[0] as ExternalAction;
    const disabled = await reconcileExternalAction(quiesce, "forward", [
      quiesce,
    ]);
    if (disabled.kind !== "settled") throw new Error("quiesce did not settle");
    expect(disabled.action.state).toBe("applied");
    const [retarget, enable] = await relocationActions([disabled.action]);
    let ledger: ExternalAction[] = [
      disabled.action,
      retarget as ExternalAction,
      enable as ExternalAction,
    ];
    const settle = (next: ExternalAction): void => {
      ledger = ledger.map((entry) => (entry.id === next.id ? next : entry));
    };
    for (const action of [retarget, enable] as ExternalAction[]) {
      const outcome = await reconcileExternalAction(action, "forward", ledger);
      expect(outcome.kind).toBe("settled");
      if (outcome.kind !== "settled") return;
      expect(outcome.action.state).toBe("applied");
      settle(outcome.action);
    }
    expect(ledger.map((entry) => entry.state)).toEqual([
      "applied",
      "applied",
      "applied",
    ]);
    expect(scheduler.get(TASK)).toContain(DESTINATION);
    expect(scheduler.get(TASK)).not.toMatch(
      /<Settings>[\s\S]*<Enabled>[\s\S]*<\/Settings>/u,
    );

    for (const action of actionsInInverseOrder(ledger)) {
      const current = ledger.find(
        (entry) => entry.id === action.id,
      ) as ExternalAction;
      const outcome = await reconcileExternalAction(current, "inverse", ledger);
      expect(outcome.kind).toBe("settled");
      if (outcome.kind !== "settled") return;
      expect(outcome.action.state).toBe("inverted");
      settle(outcome.action);
    }
    expect(canonicalTaskXml(scheduler.get(TASK) ?? "")).toBe(
      canonicalTaskXml(original),
    );
  });

  it.each(planners)(
    "treats a crash after the %s effect, before the receipt, as record-applied with no second /Create",
    async (_name, plan) => {
      const action = await plan();
      await applyWindowsTask(action);
      expect(created).toHaveLength(1);
      const outcome = await reconcileExternalAction(action, "forward", [
        action,
      ]);
      expect(outcome.kind).toBe("settled");
      if (outcome.kind !== "settled") return;
      expect(outcome.decision).toBe("record-applied");
      expect(outcome.action.state).toBe("applied");
      expect(created).toHaveLength(1);
    },
  );

  it.each(planners)(
    "settles a replayed %s rollback as none",
    async (_name, plan) => {
      const action = await plan();
      const applied = await reconcileExternalAction(action, "forward", [
        action,
      ]);
      if (applied.kind !== "settled") throw new Error("forward did not settle");
      const inverted = await reconcileExternalAction(
        applied.action,
        "inverse",
        [applied.action],
      );
      if (inverted.kind !== "settled")
        throw new Error("inverse did not settle");
      expect(inverted.action.state).toBe("inverted");
      created.length = 0;
      const replay = await reconcileExternalAction(inverted.action, "inverse", [
        inverted.action,
      ]);
      expect(replay.kind).toBe("settled");
      if (replay.kind !== "settled") return;
      expect(replay.decision).toBe("none");
      expect(created).toHaveLength(0);
    },
  );

  const unrelatedChanges: [string, (xml: string) => string][] = [
    [
      "the trigger",
      (xml) =>
        xml.replace(
          "<LogonTrigger><Enabled>true</Enabled></LogonTrigger>",
          `<LogonTrigger><Enabled>true</Enabled><UserId>${OTHER_SID}</UserId></LogonTrigger>`,
        ),
    ],
    [
      "the principal",
      (xml) =>
        xml.replace(
          `<UserId>${CALLER_SID}</UserId>`,
          `<UserId>${OTHER_SID}</UserId>`,
        ),
    ],
    [
      "the Exec command",
      (xml) =>
        xml.replace(
          /<Command>[^<]*<\/Command>/u,
          () => "<Command>C:\\Other\\run.exe</Command>",
        ),
    ],
  ];
  for (const [planName, plan] of planners) {
    for (const [changeName, change] of unrelatedChanges) {
      it(`gives a conflict and no write for a ${planName} when ${changeName} changed after planning`, async () => {
        const action = await plan();
        const edited = change(scheduler.get(TASK) ?? "");
        expect(edited).not.toBe(scheduler.get(TASK));
        scheduler.set(TASK, edited);
        const outcome = await reconcileExternalAction(action, "forward", [
          action,
        ]);
        expect(outcome.kind).toBe("conflict");
        expect(scheduler.get(TASK)).toBe(edited);
        expect(created).toHaveLength(0);
      });
    }
  }

  describe("a definition it cannot read", () => {
    const duplicateEnabled = (): string =>
      taskXml({ enabled: true, extraSetting: "<Enabled>false</Enabled>" });

    it("blocks both planners with task-unrecognized and plans no action for a duplicate Settings Enabled", async () => {
      scheduler.set(TASK, duplicateEnabled());
      const quiesce = await planWindowsTaskQuiesce({ labels: [label] });
      expect(quiesce.actions).toEqual([]);
      expect(quiesce.blockers[0]).toMatchObject({
        code: "task-unrecognized",
        object: TASK,
      });
      const relocation = await planWindowsTaskRelocation({
        labels: [label],
        roots: { sourceRoot: SOURCE, destinationRoot: DESTINATION },
        ledger: [],
      });
      expect(relocation.actions).toEqual([]);
      expect(relocation.blockers[0]).toMatchObject({
        code: "task-unrecognized",
        object: TASK,
      });
    });

    it("rejects reconciling an existing action whose task now has a duplicate Settings Enabled", async () => {
      scheduler.set(TASK, storedTask(true));
      const action = (await planWindowsTaskQuiesce({ labels: [label] }))
        .actions[0] as ExternalAction;
      scheduler.set(TASK, duplicateEnabled());
      await expect(
        reconcileExternalAction(action, "forward", [action]),
      ).rejects.toBeInstanceOf(TaskXmlUnreadableError);
      expect(created).toHaveLength(0);
    });

    it.each(planners)(
      "gives a conflict and no write for a %s when the confirm-read is malformed",
      async (_name, plan) => {
        const action = await plan();
        const before = scheduler.get(TASK) ?? "";
        let reads = 0;
        // Reads: the reconcile's observe, the gate's, then the confirm-read.
        installDeps((taskName) => {
          reads += 1;
          const xml = scheduler.get(taskName);
          if (xml === undefined) return Promise.resolve({ kind: "absent" });
          return Promise.resolve({
            kind: "xml",
            xml:
              reads >= 3
                ? xml.replace(
                    /<Description>[^<]*<\/Description>/u,
                    "<Description>a & b</Description>",
                  )
                : xml,
          });
        });
        const outcome = await reconcileExternalAction(action, "forward", [
          action,
        ]);
        expect(outcome.kind).toBe("conflict");
        expect(reads).toBeGreaterThanOrEqual(3);
        expect(scheduler.get(TASK)).toBe(before);
        expect(created).toHaveLength(0);
      },
    );
  });
});
