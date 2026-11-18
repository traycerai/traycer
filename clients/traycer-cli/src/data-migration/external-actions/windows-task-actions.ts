import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type {
  ExternalAction,
  ObjectFingerprint,
} from "@traycer/protocol/config/data-migration-contracts";
import type { CliInvocation } from "../../service/cli-binary";
import { windowsTaskName, type ServiceLabel } from "../../service/label";
import { runCommand } from "../../service/process-runner";
import { WINDOWS_SCHTASKS_CREATE_TIMEOUT_MS } from "../../service/spawn-edge-bounds";
import {
  buildWindowsHiddenHostLauncher,
  buildWindowsTaskActionForLauncher,
  parseWindowsTaskExecAction,
  windowsHiddenHostLauncherPath,
  windowsRedefinedTaskXml,
  windowsTaskRelocationDeps,
  windowsTaskXmlEnabledState,
} from "../../service/platforms/windows";
import {
  gateWindowsTaskVerb,
  readWindowsTaskOwnership,
  type PermittedWindowsTask,
  type ScheduledTaskXmlQuery,
  type WindowsTaskOwnershipDeps,
  type WindowsTaskVerbRunner,
} from "../../service/platforms/windows-task-gate";
import { planFileImageAction } from "./file-image-action";
import {
  ABSENT_FINGERPRINT,
  ExternalActionConflictError,
  externalActionId,
  layoutUnderRoot,
  pathInsideRoot,
  presentFingerprint,
  readFileImage,
  rebaseRootPath,
  samePath,
  type ExternalActionBlocker,
  type ExternalActionPlan,
  type ExternalActionStage,
} from "./ledger";

/**
 * The host's per-user Scheduled Task, moved with the data root.
 *
 * A task is three ledger actions over its whole definition plus one launcher
 * file:
 * - `quiesce`: disable an ENABLED task (the disable action is also the
 *   ledger's record that it was enabled before the migration);
 * - `prepare`: regenerate the destination copy of the hidden launcher for the
 *   destination CLI, then point the task's action at that launcher, still
 *   disabled;
 * - `activate`: re-enable only a task a `quiesce` action disabled. A task the
 *   user had disabled stays disabled.
 *
 * Every write goes through the existing ownership gate's `/Create` (a task
 * that is not this account's is refused, never written) and is a
 * compare-and-set on the WHOLE definition: the stager the gate calls with its
 * confirm-read refuses unless that read is exactly the recorded image, so a
 * concurrent edit to a trigger, the principal or a setting is a conflict, not
 * something this migration overwrites. The written definition is the task's
 * own XML with only the action (`windowsRedefinedTaskXml`) or the task-level
 * `<Settings><Enabled>` changed; the inverse writes the recorded before
 * definition back.
 *
 * The fingerprint is a digest of the definition after `canonicalTaskXml`.
 * Task Scheduler does not store a definition as written: measured on Windows
 * Server 2022, it omits a task-level `<Enabled>true</Enabled>`, moves an
 * explicit `false` to a position of its own, and stores `&quot;` as `"`. The
 * canonical form absorbs exactly those, besides serialization noise (BOM, XML
 * declaration, line endings, whitespace between elements). Any other
 * re-serialization means the after image is never observed and the action
 * ends in `conflict` - fail-closed, never a silent overwrite.
 */
export const WINDOWS_TASK_DEFINITION_ADAPTER = "windows-task-definition";

const serviceLabelSchema = z.strictObject({
  id: z.string().min(1),
  displayName: z.string().min(1),
  environment: z.string().min(1),
  devSlot: z.string().min(1).nullable(),
});

export const windowsTaskForwardSchema = z.strictObject({
  adapter: z.literal(WINDOWS_TASK_DEFINITION_ADAPTER),
  version: z.literal(1),
  stage: z.enum(["quiesce", "prepare", "activate"]),
  step: z.enum(["disable", "retarget", "enable"]),
  label: serviceLabelSchema,
  taskName: z.string().min(1),
  /** The exact definition the forward write registers. */
  xml: z.string().min(1),
});

export const windowsTaskInverseSchema = z.strictObject({
  adapter: z.literal(WINDOWS_TASK_DEFINITION_ADAPTER),
  version: z.literal(1),
  /** The exact definition read before the forward write. */
  xml: z.string().min(1),
});

export type WindowsTaskActionDeps = {
  readonly queryTaskXml: (taskName: string) => Promise<ScheduledTaskXmlQuery>;
  readonly predictCli: (label: ServiceLabel) => Promise<CliInvocation>;
  readonly ownership: WindowsTaskOwnershipDeps;
  readonly run: WindowsTaskVerbRunner;
  readonly isRegularFile: (path: string) => Promise<boolean>;
};

function defaultDeps(): WindowsTaskActionDeps {
  const { queryTaskXml, predictCli, ownership } = windowsTaskRelocationDeps();
  return {
    queryTaskXml,
    predictCli,
    ownership,
    run: runCommand,
    isRegularFile: async (path) => {
      try {
        return (await stat(path)).isFile();
      } catch {
        return false;
      }
    },
  };
}

let depsOverride: WindowsTaskActionDeps | null = null;

/** Test-only replacement for the task query, CLI prediction, gate and runner. */
export function setWindowsTaskActionDepsForTests(
  deps: WindowsTaskActionDeps | null,
): void {
  depsOverride = deps;
}

function deps(): WindowsTaskActionDeps {
  return depsOverride ?? defaultDeps();
}

/** A task definition `canonicalTaskXml` cannot read without guessing. */
export class TaskXmlUnreadableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TaskXmlUnreadableError";
  }
}

type XmlToken =
  | { readonly kind: "open"; readonly name: string; readonly raw: string }
  | { readonly kind: "close"; readonly name: string; readonly raw: string }
  | { readonly kind: "empty"; readonly name: string; readonly raw: string }
  | { readonly kind: "text"; readonly text: string };

const XML_TAG =
  /^<(\/?)([A-Za-z_][\w.:-]*)((?:\s+[A-Za-z_][\w.:-]*\s*=\s*(?:"[^"<]*"|'[^'<]*'))*)\s*(\/?)>/u;

const NAMED_REFERENCES: Readonly<Record<string, string>> = {
  lt: "<",
  gt: ">",
  amp: "&",
  quot: '"',
  apos: "'",
};

function isXmlChar(codePoint: number): boolean {
  return (
    codePoint === 0x9 ||
    codePoint === 0xa ||
    codePoint === 0xd ||
    (codePoint >= 0x20 && codePoint <= 0xd7ff) ||
    (codePoint >= 0xe000 && codePoint <= 0xfffd) ||
    (codePoint >= 0x10000 && codePoint <= 0x10ffff)
  );
}

/**
 * Element text with its character references decoded exactly once and only
 * `&`, `<`, `>` escaped again, so `&quot;` and `"` are one form. Anything
 * that is not a valid reference is refused, never passed through.
 */
function canonicalText(raw: string): string {
  const decoded = raw.replace(/&([^;&\s]*);?/gu, (whole, body: string) => {
    if (!whole.endsWith(";")) {
      throw new TaskXmlUnreadableError(
        "the task definition has a bare '&' in its text",
      );
    }
    const named = NAMED_REFERENCES[body];
    if (named !== undefined) return named;
    const numeric = /^#(?:x([0-9A-Fa-f]{1,6})|([0-9]{1,7}))$/u.exec(body);
    const codePoint =
      numeric === null
        ? null
        : numeric[1] !== undefined
          ? Number.parseInt(numeric[1], 16)
          : Number.parseInt(numeric[2] ?? "", 10);
    if (codePoint === null || !isXmlChar(codePoint)) {
      throw new TaskXmlUnreadableError(
        `the task definition has an invalid character reference '${whole.slice(0, 16)}'`,
      );
    }
    return String.fromCodePoint(codePoint);
  });
  return decoded
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;");
}

/** Tags kept verbatim (attributes included), text canonicalized; nesting checked. */
function tokenizeTaskXml(xml: string): XmlToken[] {
  const tokens: XmlToken[] = [];
  const open: string[] = [];
  let rest = xml;
  while (rest.length > 0) {
    if (rest.startsWith("<")) {
      const tag = XML_TAG.exec(rest);
      if (tag === null) {
        throw new TaskXmlUnreadableError(
          "the task definition has markup other than plain elements (a comment, CDATA, a processing instruction, or a malformed tag)",
        );
      }
      const [raw, slash, name = "", attributes = "", selfClosing] = tag;
      if (slash === "/") {
        if (
          attributes.length > 0 ||
          selfClosing === "/" ||
          open.pop() !== name
        ) {
          throw new TaskXmlUnreadableError(
            `the task definition closes <${name}> out of order`,
          );
        }
        tokens.push({ kind: "close", name, raw });
      } else if (selfClosing === "/") {
        tokens.push({ kind: "empty", name, raw });
      } else {
        open.push(name);
        tokens.push({ kind: "open", name, raw });
      }
      rest = rest.slice(raw.length);
      continue;
    }
    const end = rest.indexOf("<");
    const raw = end < 0 ? rest : rest.slice(0, end);
    if (open.length === 0 && raw.trim().length > 0) {
      throw new TaskXmlUnreadableError(
        "the task definition has text outside its root element",
      );
    }
    // Whitespace-only text between elements is layout; any other text is
    // kept exactly, surrounding spaces included.
    if (raw.trim().length > 0)
      tokens.push({ kind: "text", text: canonicalText(raw) });
    rest = rest.slice(raw.length);
  }
  if (open.length > 0) {
    throw new TaskXmlUnreadableError(
      `the task definition leaves <${open[open.length - 1] ?? ""}> unclosed`,
    );
  }
  return tokens;
}

/** Index of the token that closes the element opened at `start`. */
function closingIndex(tokens: readonly XmlToken[], start: number): number {
  let depth = 0;
  for (let index = start; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token?.kind === "open") depth += 1;
    else if (token?.kind === "close") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  throw new TaskXmlUnreadableError("the task definition is not closed");
}

/** Indexes of the element children (open or empty tokens) directly inside `[start, end]`. */
function childIndexes(
  tokens: readonly XmlToken[],
  start: number,
  end: number,
): number[] {
  const children: number[] = [];
  let index = start + 1;
  while (index < end) {
    const token = tokens[index];
    if (token?.kind === "open") {
      children.push(index);
      index = closingIndex(tokens, index) + 1;
    } else {
      if (token?.kind === "empty") children.push(index);
      index += 1;
    }
  }
  return children;
}

/**
 * The task-level `<Task><Settings><Enabled>` in one form: Task Scheduler
 * omits it when it is the default `true` and stores an explicit `false` at a
 * position of its own choosing, so `true` (or absent) canonicalizes to no
 * element and `false` to the first child of `<Settings>`. Only that element:
 * a trigger's `<Enabled>` or anything else of the name is left as it is. A
 * duplicated `<Settings>` or `<Enabled>`, or a value that is not a boolean, is
 * refused rather than read one way.
 */
function withCanonicalSettingsEnabled(tokens: XmlToken[]): XmlToken[] {
  const root = tokens[0];
  if (root?.kind !== "open" || closingIndex(tokens, 0) !== tokens.length - 1) {
    throw new TaskXmlUnreadableError(
      "the task definition does not have one root element",
    );
  }
  const settings = childIndexes(tokens, 0, tokens.length - 1).filter(
    (index) => nameOf(tokens[index]) === "Settings",
  );
  if (settings.length > 1) {
    throw new TaskXmlUnreadableError(
      "the task definition has more than one Settings element",
    );
  }
  const settingsStart = settings[0];
  if (settingsStart === undefined || tokens[settingsStart]?.kind !== "open")
    return tokens;
  const settingsEnd = closingIndex(tokens, settingsStart);
  const enabled = childIndexes(tokens, settingsStart, settingsEnd).filter(
    (index) => nameOf(tokens[index]) === "Enabled",
  );
  if (enabled.length > 1) {
    throw new TaskXmlUnreadableError(
      "the task's Settings has more than one Enabled element",
    );
  }
  const enabledStart = enabled[0];
  if (enabledStart === undefined) return tokens;
  const value = tokens[enabledStart + 1];
  if (
    tokens[enabledStart]?.kind !== "open" ||
    value?.kind !== "text" ||
    tokens[enabledStart + 2]?.kind !== "close"
  ) {
    throw new TaskXmlUnreadableError(
      "the task's Settings Enabled element has no plain value",
    );
  }
  // xs:boolean: the value's surrounding whitespace is not significant.
  const flag = value.text.trim();
  const isFalse = flag === "false" || flag === "0";
  if (!isFalse && flag !== "true" && flag !== "1") {
    throw new TaskXmlUnreadableError(
      "the task's Settings Enabled value is not a boolean",
    );
  }
  const without = [
    ...tokens.slice(0, enabledStart),
    ...tokens.slice(enabledStart + 3),
  ];
  if (!isFalse) return without;
  return [
    ...without.slice(0, settingsStart + 1),
    { kind: "open", name: "Enabled", raw: "<Enabled>" },
    { kind: "text", text: "false" },
    { kind: "close", name: "Enabled", raw: "</Enabled>" },
    ...without.slice(settingsStart + 1),
  ];
}

function nameOf(token: XmlToken | undefined): string | null {
  return token === undefined || token.kind === "text" ? null : token.name;
}

/**
 * The definition in the one form Task Scheduler's re-serialization cannot
 * change (measured on Windows, see the 718-5 qualification record): BOM, XML
 * declaration, line endings and whitespace-only text between elements
 * removed; element text with its character references decoded once and only
 * `&`, `<`, `>` re-escaped; the task-level `<Settings><Enabled>` normalized
 * (`withCanonicalSettingsEnabled`). Tags and attribute values are kept
 * exactly, and nothing else is reordered or defaulted, so any other edit
 * still changes the result. Throws `TaskXmlUnreadableError` for a definition
 * it cannot read without guessing.
 */
export function canonicalTaskXml(xml: string): string {
  const body = xml
    .replace(/^\uFEFF/u, "")
    .replace(/^\s*<\?xml[^>]*\?>/u, "")
    .replace(/\r\n?/gu, "\n")
    .trim();
  return withCanonicalSettingsEnabled(tokenizeTaskXml(body))
    .map((token) => (token.kind === "text" ? token.text : token.raw))
    .join("");
}

function taskFingerprint(taskName: string, xml: string): ObjectFingerprint {
  return presentFingerprint({ taskName, xml: canonicalTaskXml(xml) });
}

/** Whether `left` is `right`; a definition that cannot be read is not. */
function sameDefinition(left: string, right: string): boolean {
  try {
    return canonicalTaskXml(left) === canonicalTaskXml(right);
  } catch (cause) {
    if (cause instanceof TaskXmlUnreadableError) return false;
    throw cause;
  }
}

/**
 * The task's own XML with its task-level `<Settings><Enabled>` set (inserted
 * when the element is absent, which the schema reads as enabled). `null` for
 * a definition without `<Settings>`.
 */
export function withTaskSettingsEnabled(
  xml: string,
  enabled: boolean,
): string | null {
  const match = /<Settings>([\s\S]*?)<\/Settings>/u.exec(xml);
  if (match === null) return null;
  const body = match[1] ?? "";
  const element = `<Enabled>${enabled ? "true" : "false"}</Enabled>`;
  // No element nested under `<Settings>` has an `<Enabled>` of its own, so
  // the first one is the task's (`windowsTaskXmlEnabledState` reads it so).
  const nextBody = /<Enabled>[^<]*<\/Enabled>/u.test(body)
    ? body.replace(/<Enabled>[^<]*<\/Enabled>/u, element)
    : `${body}${element}`;
  return `${xml.slice(0, match.index)}<Settings>${nextBody}</Settings>${xml.slice(match.index + match[0].length)}`;
}

function planTaskAction(input: {
  readonly stage: ExternalActionStage;
  readonly step: "disable" | "retarget" | "enable";
  readonly label: ServiceLabel;
  readonly beforeXml: string;
  readonly afterXml: string;
}): ExternalAction {
  const taskName = windowsTaskName(input.label);
  return {
    id: externalActionId(`task-${input.step}`, taskName),
    kind: "service-registration",
    object: taskName,
    before: taskFingerprint(taskName, input.beforeXml),
    after: taskFingerprint(taskName, input.afterXml),
    forward: {
      adapter: WINDOWS_TASK_DEFINITION_ADAPTER,
      version: 1,
      stage: input.stage,
      step: input.step,
      label: {
        id: input.label.id,
        displayName: input.label.displayName,
        environment: input.label.environment,
        devSlot: input.label.devSlot,
      },
      taskName,
      xml: input.afterXml,
    },
    inverse: {
      adapter: WINDOWS_TASK_DEFINITION_ADAPTER,
      version: 1,
      xml: input.beforeXml,
    },
    state: "planned",
  };
}

type OwnedTaskRead =
  | { readonly kind: "absent" }
  | { readonly kind: "owned"; readonly xml: string }
  | { readonly kind: "blocked"; readonly blocker: ExternalActionBlocker };

async function readOwnedTask(label: ServiceLabel): Promise<OwnedTaskRead> {
  const taskName = windowsTaskName(label);
  const ownership = await readWindowsTaskOwnership(taskName, deps().ownership);
  if (ownership.kind === "absent") return { kind: "absent" };
  if (ownership.kind === "not-owned") {
    return {
      kind: "blocked",
      blocker: {
        code: "task-not-owned",
        object: taskName,
        message:
          ownership.reason === "other-owner"
            ? "the Scheduled Task belongs to another account"
            : "the Scheduled Task's owner could not be confirmed as this account",
      },
    };
  }
  try {
    canonicalTaskXml(ownership.xml);
  } catch (cause) {
    if (!(cause instanceof TaskXmlUnreadableError)) throw cause;
    return {
      kind: "blocked",
      blocker: {
        code: "task-unrecognized",
        object: taskName,
        message: cause.message,
      },
    };
  }
  return { kind: "owned", xml: ownership.xml };
}

/**
 * `quiesce`: disable each owned, enabled task. Absent tasks need nothing;
 * a task that is not this account's, or whose enabled state cannot be read,
 * blocks the migration before anything changes.
 */
export async function planWindowsTaskQuiesce(input: {
  readonly labels: readonly ServiceLabel[];
}): Promise<ExternalActionPlan> {
  const actions: ExternalAction[] = [];
  const blockers: ExternalActionBlocker[] = [];
  for (const label of input.labels) {
    const read = await readOwnedTask(label);
    if (read.kind === "absent") continue;
    if (read.kind === "blocked") {
      blockers.push(read.blocker);
      continue;
    }
    const state = windowsTaskXmlEnabledState(read.xml);
    if (state.kind === "disabled") continue;
    const disabled =
      state.kind === "enabled"
        ? withTaskSettingsEnabled(read.xml, false)
        : null;
    if (disabled === null) {
      blockers.push({
        code: "task-unrecognized",
        object: windowsTaskName(label),
        message:
          state.kind === "unknown"
            ? `the Scheduled Task's enabled state cannot be read (${state.reason})`
            : "the Scheduled Task has no Settings element",
      });
      continue;
    }
    actions.push(
      planTaskAction({
        stage: "quiesce",
        step: "disable",
        label,
        beforeXml: read.xml,
        afterXml: disabled,
      }),
    );
  }
  return { actions, blockers };
}

export type DataRootPair = {
  readonly sourceRoot: string;
  readonly destinationRoot: string;
};

function rebaseInvocation(
  cli: CliInvocation,
  roots: DataRootPair,
): CliInvocation {
  const move = (value: string): string =>
    rebaseRootPath(value, roots.sourceRoot, roots.destinationRoot, "win32") ??
    value;
  return { command: move(cli.command), args: cli.args.map(move) };
}

function referencesRoot(value: string, root: string): boolean {
  const needle = root
    .replace(/[\\/]+$/u, "")
    .replace(/\//gu, "\\")
    .toLowerCase();
  return value.replace(/\//gu, "\\").toLowerCase().includes(`${needle}\\`);
}

function wasDisabledByMigration(
  ledger: readonly ExternalAction[],
  taskName: string,
): boolean {
  return ledger.some((action) => {
    const forward = windowsTaskForwardSchema.safeParse(action.forward);
    return (
      forward.success &&
      forward.data.step === "disable" &&
      forward.data.taskName === taskName &&
      action.state === "applied"
    );
  });
}

/**
 * `prepare` + `activate`, planned once the destination copy is verified and
 * repaired: for each owned task, the destination launcher regenerated for the
 * destination CLI, the task pointed at it (still disabled), and - only when
 * `ledger` holds this transaction's applied `quiesce` disable for it - the
 * post-activation enable.
 *
 * The destination CLI is the service invocation `host service refresh` would
 * register (`predictServiceCliInvocation`), moved from the source root to the
 * destination when it lies inside the source; a CLI outside the data root (npm,
 * hand-placed) is kept. The moved binary must exist in the destination. A task
 * whose action still names the source root in any form other than today's
 * launcher action (a pre-launcher `cli-v1.0-1.1.4` registration, a hand edit)
 * blocks: `traycer host service refresh` brings it to the current form.
 */
export async function planWindowsTaskRelocation(input: {
  readonly labels: readonly ServiceLabel[];
  readonly roots: DataRootPair;
  readonly ledger: readonly ExternalAction[];
}): Promise<ExternalActionPlan> {
  const { roots } = input;
  const actions: ExternalAction[] = [];
  const blockers: ExternalActionBlocker[] = [];
  for (const label of input.labels) {
    const taskName = windowsTaskName(label);
    const read = await readOwnedTask(label);
    if (read.kind === "absent") continue;
    if (read.kind === "blocked") {
      blockers.push(read.blocker);
      continue;
    }
    const enabledState = windowsTaskXmlEnabledState(read.xml);
    if (enabledState.kind !== "disabled") {
      blockers.push({
        code: "task-enabled-during-migration",
        object: taskName,
        message:
          "the Scheduled Task must be disabled while the migration holds the startup barrier",
      });
      continue;
    }
    const action = parseWindowsTaskExecAction(read.xml);
    if (action === null) {
      blockers.push({
        code: "task-unrecognized",
        object: taskName,
        message: "the Scheduled Task does not have exactly one Exec action",
      });
      continue;
    }
    const launcherPath = windowsHiddenHostLauncherPath(label);
    const sourceLauncher = layoutUnderRoot(
      launcherPath,
      roots.sourceRoot,
      "win32",
    );
    const destinationLauncher = layoutUnderRoot(
      launcherPath,
      roots.destinationRoot,
      "win32",
    );
    const sourceAction = buildWindowsTaskActionForLauncher(sourceLauncher);
    const runsSourceLauncher =
      samePath(action.command, sourceAction.command, "win32") &&
      action.argumentsLine === sourceAction.argumentsLine;
    let current = read.xml;
    if (runsSourceLauncher) {
      let cli: CliInvocation;
      try {
        cli = rebaseInvocation(await deps().predictCli(label), roots);
      } catch (cause) {
        blockers.push({
          code: "destination-cli-unresolved",
          object: taskName,
          message: `the CLI the task should run could not be resolved (${cause instanceof Error ? cause.message : String(cause)})`,
        });
        continue;
      }
      if (
        pathInsideRoot(cli.command, roots.sourceRoot, "win32") !== null ||
        !(await deps().isRegularFile(cli.command))
      ) {
        blockers.push({
          code: "destination-cli-missing",
          object: cli.command,
          message:
            "the destination CLI binary the task would run is not a file",
        });
        continue;
      }
      const launcherBytes = Buffer.from(
        `\uFEFF${buildWindowsHiddenHostLauncher(cli, label)}`,
        "utf16le",
      );
      const copied = await readFileImage(destinationLauncher);
      if (copied === null || !copied.equals(launcherBytes)) {
        actions.push(
          planFileImageAction({
            kind: "service-registration",
            stage: "prepare",
            path: destinationLauncher,
            before: copied,
            after: launcherBytes,
          }),
        );
      }
      const retargeted = windowsRedefinedTaskXml(
        read.xml,
        buildWindowsTaskActionForLauncher(destinationLauncher),
      );
      actions.push(
        planTaskAction({
          stage: "prepare",
          step: "retarget",
          label,
          beforeXml: read.xml,
          afterXml: retargeted,
        }),
      );
      current = retargeted;
    } else if (
      referencesRoot(action.command, roots.sourceRoot) ||
      referencesRoot(action.argumentsLine, roots.sourceRoot)
    ) {
      blockers.push({
        code: "task-action-not-current",
        object: taskName,
        message:
          "the Scheduled Task's action names the data root in an older or edited form; run `traycer host service refresh` first",
      });
      continue;
    }
    if (wasDisabledByMigration(input.ledger, taskName)) {
      const enabled = withTaskSettingsEnabled(current, true);
      if (enabled === null) {
        blockers.push({
          code: "task-unrecognized",
          object: taskName,
          message: "the Scheduled Task has no Settings element",
        });
        continue;
      }
      actions.push(
        planTaskAction({
          stage: "activate",
          step: "enable",
          label,
          beforeXml: current,
          afterXml: enabled,
        }),
      );
    }
  }
  return { actions, blockers };
}

// ---- Adapter ----------------------------------------------------------------

export async function observeWindowsTask(
  action: ExternalAction,
): Promise<ObjectFingerprint> {
  const forward = windowsTaskForwardSchema.parse(action.forward);
  const query = await deps().queryTaskXml(forward.taskName);
  if (query.kind === "absent") return ABSENT_FINGERPRINT;
  if (query.kind === "failed") {
    throw new Error(`the Scheduled Task could not be read (${query.reason})`);
  }
  return taskFingerprint(forward.taskName, query.xml);
}

export function applyWindowsTask(action: ExternalAction): Promise<void> {
  const forward = windowsTaskForwardSchema.parse(action.forward);
  const inverse = windowsTaskInverseSchema.parse(action.inverse);
  return writeTaskDefinition(forward, inverse.xml, forward.xml);
}

export function invertWindowsTask(action: ExternalAction): Promise<void> {
  const forward = windowsTaskForwardSchema.parse(action.forward);
  const inverse = windowsTaskInverseSchema.parse(action.inverse);
  return writeTaskDefinition(forward, forward.xml, inverse.xml);
}

/**
 * `/Create /F` of `nextXml` through the ownership gate, only while the task's
 * definition is exactly `expectedXml`. The gate calls the stager with its own
 * read and again with its confirm-read immediately before the verb; the stager
 * refuses any definition but the expected one, so the write is decided by the
 * latest read the gate can take.
 */
async function writeTaskDefinition(
  forward: z.infer<typeof windowsTaskForwardSchema>,
  expectedXml: string,
  nextXml: string,
): Promise<void> {
  const label: ServiceLabel = forward.label;
  const gate = await gateWindowsTaskVerb(label, "create", deps().ownership);
  if (gate.kind === "not-owned") {
    throw new ExternalActionConflictError(
      forward.taskName,
      "the Scheduled Task is not this account's",
    );
  }
  const stagedDirs: string[] = [];
  const stage = async (task: PermittedWindowsTask): Promise<string> => {
    if (task.kind === "absent" || !sameDefinition(task.xml, expectedXml)) {
      throw new ExternalActionConflictError(
        forward.taskName,
        "the Scheduled Task's definition changed since the migration recorded it",
      );
    }
    const dir = await mkdtemp(join(tmpdir(), "traycer-task-"));
    stagedDirs.push(dir);
    const xmlPath = join(dir, "task.xml");
    await writeFile(xmlPath, Buffer.from(`\uFEFF${nextXml}`, "utf16le"));
    return xmlPath;
  };
  try {
    await gate.exec(deps().run, stage, {
      env: undefined,
      cwd: undefined,
      timeoutMs: WINDOWS_SCHTASKS_CREATE_TIMEOUT_MS,
      tolerateNonZeroExit: false,
    });
  } finally {
    for (const dir of stagedDirs) {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}
