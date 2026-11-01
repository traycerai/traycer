/**
 * Every user-facing sandbox string the redesign's spec fixes, spelled once.
 * The pickers, the consequences block, the setup line, the hover card and
 * Settings › Sandboxes import from here and never retype a sentence; the
 * environments pages import {@link moveClause} and {@link LOCAL_SUB_LINE}.
 *
 * Amounts are millicredits; a credit is a dollar, so a price reads `$0.12`.
 */
import type {
  SandboxLifecycleVerb,
  SandboxCreditSource,
  SandboxOs,
} from "@traycer/protocol/host/sandbox-control";
import {
  formatCredits,
  formatCreditsRequired,
  formatMemory,
} from "@/lib/sandboxes/sandbox-pricing";
import { UNRELEASED_FEATURES_ENABLED } from "@/unreleased-features";

/**
 * The version of the consequences block's wording. A full render is recorded
 * as shown against it, so changing a clause's words re-opens the block for
 * everyone once.
 */
export const CONSEQUENCES_WORDING_VERSION = 1;

/** A configuration as copy reads it: Personal, or a team by its name. */
export type SandboxConfigurationCopy =
  | { readonly kind: "personal" }
  | { readonly kind: "team"; readonly teamName: string };

/** `Personal`, or the team's name. */
export function configurationLabel(
  configuration: SandboxConfigurationCopy,
): string {
  return configuration.kind === "personal"
    ? "Personal"
    : configuration.teamName;
}

/** `$0.12`: an amount of millicredits as dollars. */
export function formatSandboxDollars(mc: number): string {
  return `$${formatCredits(mc)}`;
}

/**
 * A cost: `$0.02`, or `under $0.01` below a cent, never a rounded `$0.00`.
 * Every amount the sandboxes UI says was spent goes through it.
 */
export function formatSandboxCost(mc: number): string {
  return mc < MC_PER_CENT ? UNDER_A_CENT : formatSandboxDollars(mc);
}

/** `$1.20`, rounded up: an amount the person is told to add. */
function formatSandboxDollarsRequired(mc: number): string {
  return `$${formatCreditsRequired(mc)}`;
}

/** `Linux` / `Windows`. */
export function sandboxOsLabel(os: SandboxOs): string {
  return os === "windows" ? "Windows" : "Linux";
}

/** `2 vCPU · 4 GB`. */
export function sandboxShapeLabel(cpus: number, memoryMb: number): string {
  return `${cpus} vCPU · ${formatMemory(memoryMb)}`;
}

// ── The picker ────────────────────────────────────────────────────────────

/** The defining line, met once where a sandbox is first offered. */
export const SANDBOX_DEFINING_LINE =
  "a computer in the cloud, billed by the hour while awake";

/** The New group's header: `New sandbox · <defining line>`. */
export function sandboxDefiningLine(): string {
  return `New sandbox · ${SANDBOX_DEFINING_LINE}`;
}

export const YOURS_GROUP_LABEL = "Yours";
export const SANDBOXES_YOU_STARTED_LABEL = "Sandboxes you started";
export const IN_THIS_TASK_LABEL = "In this task";
export const MANAGE_SANDBOXES_IN_SETTINGS = "Manage sandboxes in Settings";

/** `2 · 1 awake`: the collapsed header's count. */
export function sandboxesYouStartedCount(total: number, awake: number): string {
  return `${total} · ${awake} awake`;
}

/** `New Acme sandbox`. */
export function newSandboxRowLabel(
  configuration: SandboxConfigurationCopy,
): string {
  return `New ${configurationLabel(configuration)} sandbox`;
}

/**
 * The collapsed New group's header past two configurations:
 * `4 teams: e9-frozen-team, pool-e2e-fixture, testteam, traycerai`.
 */
export function collapsedConfigurationsLabel(
  configurations: readonly SandboxConfigurationCopy[],
): string {
  const teams = configurations.flatMap((configuration) =>
    configuration.kind === "team" ? [configuration.teamName] : [],
  );
  const teamsLabel = `${teams.length} ${teams.length === 1 ? "team" : "teams"}: ${teams.join(", ")}`;
  return teams.length === configurations.length
    ? teamsLabel
    : `Personal and ${teamsLabel}`;
}

/** The search field above a host list; the ellipsis spelling is the older one. */
export const SEARCH_HOSTS_PLACEHOLDER = UNRELEASED_FEATURES_ENABLED
  ? "Search hosts"
  : "Search hosts…";

/** The chip and row title of the machine this app runs on. */
export const THIS_COMPUTER = "This computer";

/** A computer row's status: it answers. */
export const COMPUTER_ACTIVE = "Active";

/**
 * A computer row's status while it does not answer:
 * `Offline since Tue 09:12 · picking it waits for it`. `since` is `null`
 * when it was never seen; `pickable` says the row can be picked.
 */
export function computerOfflineLine(
  since: string | null,
  pickable: boolean,
): string {
  const offline = since === null ? "Offline" : `Offline since ${since}`;
  return pickable ? `${offline} · picking it waits for it` : offline;
}

/**
 * A computer row's sub-line, its known parts joined:
 * `windows-test-machine · Windows · Active`, `Linux · Active`.
 */
export function computerSubLine(parts: readonly (string | null)[]): string {
  return parts.filter((part) => part !== null).join(" · ");
}

/** The sub-line of a computer whose settings are not in Personal yet. */
export const LOCAL_SUB_LINE = "Local · its own settings, not in Personal yet";

/** The search found nothing of the viewer's. */
export function noHostMatchesLine(term: string): string {
  return `No host of yours matches "${term}".`;
}
export const NO_MATCH_ELSEWHERE_LINE =
  "Other members' and agent sandboxes are in Settings.";

// ── Money ─────────────────────────────────────────────────────────────────

/** `uses your credits` / `uses your Acme credits`. */
export function usesCreditsClause(
  configuration: SandboxConfigurationCopy,
): string {
  return configuration.kind === "personal"
    ? "uses your credits"
    : `uses your ${configuration.teamName} credits`;
}

/** The cost line: `$0.12 an hour while awake · uses your Acme credits`. */
export function costLine(
  priceMcPerHour: number,
  configuration: SandboxConfigurationCopy,
): string {
  return `${formatSandboxDollars(priceMcPerHour)} an hour while awake · ${usesCreditsClause(configuration)}`;
}

/**
 * The cost line where this server prices no shape: what it costs is said
 * on the created sandbox's own row.
 */
export function unpricedCostLine(
  configuration: SandboxConfigurationCopy,
): string {
  return `Billed by the hour while awake · ${usesCreditsClause(configuration)}`;
}

/** Under this, a rate or a cost reads `under $0.01`, never a rounded zero. */
const MC_PER_CENT = 10;
const UNDER_A_CENT = "under $0.01";

/** `$0.21 an hour`, or `under $0.01 an hour` for a rate below a cent. */
export function hourlyRate(mcPerHour: number): string {
  return mcPerHour > 0 && mcPerHour < MC_PER_CENT
    ? `${UNDER_A_CENT} an hour`
    : `${formatSandboxDollars(mcPerHour)} an hour`;
}

/**
 * A sandbox's rates: `$0.21 an hour while awake · under $0.01 an hour while
 * resting`. Resting is the higher of the suspended and stopped storage
 * rates, so the figure never understates either.
 */
export function awakeAndRestingRates(price: {
  readonly awakeMc: number;
  readonly suspendedMc: number;
  readonly stoppedMc: number;
}): string {
  return `${hourlyRate(price.awakeMc)} while awake · ${hourlyRate(Math.max(price.suspendedMc, price.stoppedMc))} while resting`;
}

/** The chip's short price: `$0.12/h`. */
export function shortPriceLabel(priceMcPerHour: number): string {
  return `${formatSandboxDollars(priceMcPerHour)}/h`;
}

/** The New row's head at a zero or short balance: `needs credits`. */
export const NEEDS_CREDITS = "needs credits";

/**
 * The funded New row's sub-line price: `$0.12 an hour while awake`, `from`
 * unless it is the one shape the catalogue prices exactly.
 */
export function fundedRowPrice(priceMcPerHour: number, exact: boolean): string {
  const price = `${formatSandboxDollars(priceMcPerHour)} an hour while awake`;
  return exact ? price : `from ${price}`;
}

/** The New row's sub-line price at a zero or short balance. */
export function needsCreditsRow(priceMcPerHour: number): string {
  return `from ${formatSandboxDollars(priceMcPerHour)} an hour`;
}

export const ADD_CREDITS_LINK = "Add credits ↗";

// ── The consequences block ────────────────────────────────────────────────

/** The audience clause: the task has or may gain readers beyond the person. */
export function audienceClause(
  configuration: SandboxConfigurationCopy,
): string {
  return configuration.kind === "personal"
    ? "Chats and files in this task are visible to everyone in the task."
    : `Chats and files in this task are visible to everyone in the task, who may be outside ${configuration.teamName}.`;
}

/**
 * The reach sentence. `host` is the other host's name, or `your hosts` where
 * the reader may not learn it ({@link REACH_UNNAMED_HOSTS}).
 */
export function reachSentence(host: string): string {
  return `Agents here cannot work with the agents on ${host}; the task still shares its files and chats.`;
}
export const REACH_UNNAMED_HOSTS = "your hosts";

/** The reach remedy on `This computer` in a task on a team host. */
export function reachRemedyLine(teamName: string): string {
  return `To work together, start this agent on a host in ${teamName}.`;
}

/** The team clause. */
export function teamClause(teamName: string): string {
  return `Everyone in ${teamName} can use it, and agents here run as the host: another member's agent can read what yours can.`;
}

export const RESTING_STORAGE_CLAUSE =
  "Storage while it rests, on the same credits until another member wakes it.";
export function restingStorageClause(): string {
  return RESTING_STORAGE_CLAUSE;
}

export const SHARED_USE_CLAUSE = "Other members can use it while you pay.";
export function sharedUseClause(): string {
  return SHARED_USE_CLAUSE;
}

/** The move clause: `computer` still holds settings not in Personal yet. */
export function moveClause(computer: string): string {
  return `Starts with Personal's settings. ${computer}'s are not in Personal yet.`;
}
export const MOVE_THEM_FIRST = "Move them first";

export const WHAT_THIS_MEANS = "What this means";
export const SHOW_LESS = "Show less";

// ── Wake strings and resting ──────────────────────────────────────────────

export const WAKE_STRING_MEMORY = "Suspend keeps memory";
export const WAKE_STRING_DISK =
  "Suspend keeps the disk; processes restart on resume";

/**
 * The wake string for the catalogue's `suspendFidelity`: `memory` keeps
 * memory, every other class keeps the disk at most. `null` for a value this
 * build does not know, which shows no wake string.
 */
export function wakeString(suspendFidelity: string): string | null {
  switch (suspendFidelity) {
    case "memory":
      return WAKE_STRING_MEMORY;
    case "disk":
      return WAKE_STRING_DISK;
    default:
      return null;
  }
}

/** `Suspends after 30 idle min · destroyed after 7 resting days`. */
export function idleAndRestingLine(
  idleMinutes: number,
  destroyAfterRestingMinutes: number | null,
): string {
  const idle = `Suspends after ${idleMinutes} idle min`;
  // `0` is never, as the server spells it.
  return destroyAfterRestingMinutes === null || destroyAfterRestingMinutes === 0
    ? `${idle} · ${KEPT_UNTIL_YOU_DESTROY_IT}`
    : `${idle} · destroyed after ${restingPeriodLabel(destroyAfterRestingMinutes)}`;
}

/** `7 resting days`, `12 resting hours`, `45 resting minutes`. */
export function restingPeriodLabel(minutes: number): string {
  if (minutes % (24 * 60) === 0) {
    const days = minutes / (24 * 60);
    return `${days} resting ${days === 1 ? "day" : "days"}`;
  }
  if (minutes % 60 === 0) {
    const hours = minutes / 60;
    return `${hours} resting ${hours === 1 ? "hour" : "hours"}`;
  }
  return `${minutes} resting ${minutes === 1 ? "minute" : "minutes"}`;
}

export const KEPT_UNTIL_YOU_DESTROY_IT = "kept until you destroy it";
export const CHANGE_LABEL = "Change";

// ── Chip ──────────────────────────────────────────────────────────────────

/**
 * The chip of a staged create: `New Acme sandbox · 2 vCPU · 4 GB · $0.12/h`.
 * `priceIsFrom` reads the price as a lower bound (`from $0.12/h`): the
 * balance is short, or the price is the region's smallest shape's.
 */
export function stagedChipLabel(args: {
  readonly configuration: SandboxConfigurationCopy;
  readonly cpus: number;
  readonly memoryMb: number;
  readonly priceMcPerHour: number | null;
  readonly priceIsFrom: boolean;
}): string {
  const head = `${newSandboxRowLabel(args.configuration)} · ${sandboxShapeLabel(args.cpus, args.memoryMb)}`;
  if (args.priceMcPerHour === null) return head;
  const price = shortPriceLabel(args.priceMcPerHour);
  return `${head} · ${args.priceIsFrom ? `from ${price}` : price}`;
}

/** A resting pick: `api-refactor · suspended, resumes on send`. */
export function suspendedPickLabel(name: string): string {
  return `${name} · suspended, resumes on send`;
}
export function stoppedPickLabel(name: string): string {
  return `${name} · stopped, starts on send`;
}
/** A resting pick once its wake is done: `api-refactor · awake`. */
export function awakePickLabel(name: string): string {
  return `${name} · awake`;
}

/** No provider here can create a sandbox: the New rows and the shape sheet. */
export const SANDBOXES_CANT_BE_CREATED =
  "Sandboxes can't be created on this account right now.";

/** The workspace slot of a sandbox that starts empty. */
export const EMPTY_SANDBOX = "Empty sandbox";

// ── Shape sheet ───────────────────────────────────────────────────────────

export const SHAPE_SHEET_DESCRIPTION =
  "Used for this sandbox and remembered for your next one.";
export const SANDBOX_REGION_LABEL = "Sandbox region";
export const USE_THIS_SHAPE = "Use this shape";

// ── Refusals at send ──────────────────────────────────────────────────────

interface SandboxCreditLineOptions {
  readonly waking: boolean;
  readonly context: "sentence" | "clause";
}

/**
 * Short for an hour, Personal: `Not enough credits. $1.20 more starts …`.
 * `null` when the refusal named no amount: the line names none either.
 */
export function notEnoughCreditsLine(shortfallMc: number | null): string {
  return notEnoughCreditsText(shortfallMc, {
    waking: false,
    context: "sentence",
  });
}

/** A refusal without a named pot, built for its caller's sentence context. */
function notEnoughCreditsText(
  shortfallMc: number | null,
  options: SandboxCreditLineOptions,
): string {
  const { waking, context } = options;
  const opening =
    context === "sentence" ? "Not enough credits" : "not enough credits";
  if (shortfallMc === null) {
    return `${opening} to ${waking ? "wake" : "start"} this sandbox for an hour.`;
  }
  const action = waking ? "wakes it" : "starts this sandbox";
  return `${opening}. ${formatSandboxDollarsRequired(shortfallMc)} more ${action} for an hour.`;
}

/** Short for an hour on a team allowance; `null` names no amount. */
export function teamAllowanceShortLine(
  teamName: string,
  shortfallMc: number | null,
): string {
  if (shortfallMc === null) {
    return `Your ${teamName} allowance is too short to start this sandbox for an hour.`;
  }
  const amount = formatSandboxDollarsRequired(shortfallMc);
  return `Your ${teamName} allowance is short ${amount}. ${amount} more starts this sandbox for an hour.`;
}

/**
 * A spend refusal names the pot checked, with amounts rounded up for top-up.
 * Sentence/clause context is independent of whether this starts or wakes.
 */
export function sandboxCreditShortLine(
  configuration: SandboxConfigurationCopy,
  creditSource: SandboxCreditSource | null,
  shortfallMc: number | null,
  options: SandboxCreditLineOptions,
): string {
  const { waking, context } = options;
  if (creditSource === null || (!waking && creditSource === "personal")) {
    return notEnoughCreditsText(shortfallMc, options);
  }
  const allowance = creditSource === "team-allowance";
  const whose = context === "sentence" ? "Your" : "your";
  // The refusal names the pot; the configuration only supplies the team's
  // name. A refusal from a team pot with no team configuration known (the
  // directory had no row) still says it was the team's, never the person's.
  let pot = `${whose} credits`;
  if (creditSource !== "personal") {
    if (configuration.kind === "team") {
      pot = `${whose} ${configuration.teamName} ${allowance ? "allowance" : "credits"}`;
    } else {
      pot = `${whose} ${allowance ? "team allowance" : "team's credits"}`;
    }
  }
  if (shortfallMc === null) {
    if (!waking && allowance)
      return `${pot} is too short to start this sandbox for an hour.`;
    return `${pot} ${allowance ? "doesn't" : "don't"} cover an hour of this sandbox.`;
  }
  const action = waking ? "wakes it" : "starts this sandbox";
  const amount = formatSandboxDollarsRequired(shortfallMc);
  return `${pot} ${allowance ? "is" : "are"} short ${amount}. ${amount} more ${action} for an hour.`;
}

export const COULDNT_VERIFY_BALANCE = "Couldn't verify your balance.";

/** `EU Frankfurt doesn't offer 4 vCPU · 16 GB.` */
export function shapeNotOfferedLine(region: string, shape: string): string {
  return `${region.length === 0 ? "This region" : region} doesn't offer ${shape}.`;
}

export const SANDBOXES_UNAVAILABLE = "Sandboxes are unavailable right now.";

/** Held while the catalogue says which agents sandboxes run. */
export const CHECKING_SANDBOX_AGENTS =
  "Checking which agents run on sandboxes.";

/** The catalogue could not be read, so Send is held until Retry reads it. */
export const COULDNT_CHECK_SANDBOX_AGENTS =
  "Couldn't check which agents run on sandboxes.";

export function agentNotOfferedOnSandboxesLine(agent: string): string {
  return `${agent} doesn't run on sandboxes. Choose a Traycer model to run agents here.`;
}

/** A Traycer model this sandbox's catalog does not list. */
export function modelNotOnSandboxLine(model: string): string {
  return `${model} doesn't run on this sandbox. Choose another Traycer model to run agents here.`;
}

/**
 * The sandbox's own Traycer Inference switch is off. A line that names the
 * sandbox passes its name; a composer on that sandbox passes `null`.
 */
export function traycerOffOnSandboxLine(name: string | null): string {
  return `Traycer Inference is off on ${name ?? "this sandbox"}, so agents can't run on it.`;
}

/** The sandbox is up, and no agent the send asked for can run on it. */
export function agentsCantRunOnSandboxLine(name: string | null): string {
  return `Agents can't run on ${name ?? "this sandbox"}.`;
}

/**
 * The new sandbox is up but the send handed to it stopped short:
 * `review-box is ready, but nothing was sent.`
 */
export function readyButNotSentLine(name: string): string {
  return `${name} is ready, but nothing was sent.`;
}
export function openProvidersLabel(configuration: string): string {
  return `Open ${configuration}'s Providers`;
}

export const RETRY = "Retry";
export const CHOOSE_ANOTHER_HOST = "Choose another host";
/**
 * Takes a stage off its composer, which goes back to the host its chip then
 * shows. `null`: that host has no name yet.
 */
export function stageFallbackHostLine(hostName: string | null): string {
  return hostName === null ? "Use another host" : `Use ${hostName}`;
}
export const CHOOSE_A_SMALLER_SHAPE = "Choose a smaller shape";
export const CHANGE_SHAPE_OR_REGION = "Change shape or region";
export const OPEN_TERMINAL_INSTEAD = "Open terminal instead";
export const OPEN_TERMINAL = "Open terminal";

// ── The setup line ────────────────────────────────────────────────────────

export const STARTING_SANDBOX = "Starting sandbox";
export const RESUMING_SANDBOX = "Resuming sandbox";
export const SANDBOX_AWAKE = "Sandbox awake";
export const SANDBOX_READY = "Sandbox ready";
/** The setup line names the sandbox; a row's button passes `null`. */
export function stoppingSandboxLine(name: string | null): string {
  return `Stopping${name === null ? "" : ` ${name}`} · pending`;
}
export function stoppedSandboxLine(
  name: string,
  savedInDrafts: boolean,
): string {
  return `Stopped ${name}. ${returnedSandboxMessageLine(savedInDrafts)}`;
}
export function returnedSandboxMessageLine(savedInDrafts: boolean): string {
  return `Your message wasn't sent; ${savedInDrafts ? "it's saved in your drafts." : "it's back in the composer."}`;
}
/** A rest's give-back the composer had no room for, after its state line. */
export function restedDraftLine(restingLine: string): string {
  return `${restingLine}. ${returnedSandboxMessageLine(true)}`;
}
export function couldntStopLine(name: string): string {
  return `Couldn't stop ${name}`;
}
/** The settled line's time to ready: `24 s`. */
export function readySecondsLabel(seconds: number): string {
  return `${seconds} s`;
}
export const STARTING_TAKING_LONGER =
  "Starting sandbox is taking longer than usual";
export const RESUMING_TAKING_LONGER =
  "Resuming sandbox is taking longer than usual";

export const STEP_CREATING = "Creating sandbox";
export const STEP_BOOTING = "Booting";
export const STEP_RESUMING = "Resuming";
export function stepApplyingSettings(configuration: string): string {
  return `Applying ${configuration}'s settings`;
}
export const STEP_DELIVERING = "Delivering your message";

/**
 * The taking-longer detail: `Last step: Booting, reported 3:50 ago · …`.
 * `awake` once the sandbox has woken: compute is charged from then on.
 */
export function takingLongerDetail(
  step: string,
  age: string,
  awake: boolean,
): string {
  return `Last step: ${step}, reported ${age} ago · your message waits · ${awake ? "compute is charged while it is awake" : "nothing is billed until it is awake"}`;
}

export const KEEP_WAITING = "Keep waiting";
export const CANCEL_AND_KEEP_THE_DRAFT = "Cancel and keep the draft";

export function couldntStartLine(name: string): string {
  return `Couldn't start ${name}`;
}
export function couldntResumeLine(name: string): string {
  return `Couldn't resume ${name}`;
}
export const MESSAGE_STILL_PENDING = "Your message is still pending.";
export const RETRY_CREATION = "Retry creation";
export const CANCEL_THE_MESSAGE = "Cancel the message";
export const COPY_SUPPORT_REFERENCE = "Copy support reference";
export const DETAILS = "Details";
export const START_NEW_WORK_ON_ANOTHER_HOST = "Start new work on another host";

const ROW_VERB_PENDING: Record<
  Exclude<SandboxLifecycleVerb, "stop"> | "destroy",
  string
> = {
  start: "Starting · pending",
  resume: "Resuming · pending",
  suspend: "Suspending · pending",
  destroy: "Destroying · pending",
};

export function sandboxVerbPendingLine(
  verb: SandboxLifecycleVerb | "destroy",
): string {
  if (verb === "stop") return stoppingSandboxLine(null);
  return ROW_VERB_PENDING[verb];
}

export function sandboxVerbFailureLine(
  verb: SandboxLifecycleVerb | "destroy",
  name: string,
  reference: string,
): string {
  const sentence =
    verb === "stop" ? couldntStopLine(name) : `Couldn't ${verb} ${name}`;
  return `${sentence} · ${reference}`;
}

export const COMPUTE_CHARGED_WHILE_AWAKE =
  "Compute is charged while it is awake.";

/** A settings failure's line once its sandbox is no longer awake: no claim it is. */
export function settingsDidntApplyOnLine(
  configuration: string,
  name: string,
  reference: string,
): string {
  return `${configuration}'s settings didn't apply on ${name} · ${reference}`;
}

export const RETRY_APPLYING = "Retry applying";
export const STOP = "Stop";

/** The settled line's idle rule, with the configured period. */
export function idleRuleLine(idleMinutes: number): string {
  return `After ${idleMinutes} minutes with no agent turn, running shell or browser tab on screen, this sandbox suspends. Closing this tab does not stop running work or immediately stop charges; storage is charged while it rests.`;
}

// ── Who: started, kept, paid ──────────────────────────────────────────────

export function startedByLine(name: string): string {
  return `Started by ${name}`;
}
export function keptByLine(name: string): string {
  return `Kept by ${name}`;
}
export function paidByLine(name: string): string {
  return `Paid by ${name}`;
}

// ── Agent sandboxes and Keep ──────────────────────────────────────────────

export const AGENT_SANDBOX = "Agent sandbox";
export const KEEP_THIS_SANDBOX = "Keep this sandbox";
export const GIVE_IT_ANOTHER_7_DAYS = "Give it another 7 days";

/** `Agent sandbox · created by Planner`. */
export function agentSandboxCreatedByLine(agent: string): string {
  return `${AGENT_SANDBOX} · created by ${agent}`;
}

/** `destroys itself after 30 idle minutes · files on it are lost then`. */
export function burstIdleLine(idleMinutes: number): string {
  return `destroys itself after ${idleMinutes} idle minutes · files on it are lost then`;
}

/** The shorter picker form: `destroys itself after 30 idle min`. */
export function burstIdleShortLine(idleMinutes: number): string {
  return `destroys itself after ${idleMinutes} idle min`;
}

export const FILES_NOT_RECOVERABLE =
  "Files on this sandbox cannot be recovered; published chats stay readable.";

/** Keep's preview before it acts. */
export function keepPreviewLine(restingDays: number, date: string): string {
  return `Stops deleting itself when idle. Destroyed after ${restingDays} resting days instead, on ${date} if it rests from now. Paid by you while awake.`;
}

export function alreadyDestroyedLine(name: string): string {
  return `${name} was already destroyed`;
}

// ── Hover card actions ────────────────────────────────────────────────────

export const FILES = "Files";
export const TASK_FILES = "Task files";

// ── Hover card ────────────────────────────────────────────────────────────

export const HOST_LABEL = "Host";
export const SESSIONS_UNKNOWN = "Sessions unknown · no report yet";

/** A team sandbox to a reader authorized only over the task. */
export function hoverTaskConfiguration(teamName: string | null): string {
  return `a sandbox of ${teamName ?? "a team"}`;
}

export function hoverAlsoInTask(names: string): string {
  return `Also in this task on it: ${names}`;
}

export function hoverMoreSessions(count: number): string {
  return `${count} more in other tasks`;
}

export function hoverAwakeMinutes(minutes: number): string {
  return `${minutes} min awake`;
}

/** A wake's accrual while it is under a cent: never a rounded `$0.00`. */
export const LESS_THAN_A_CENT_SO_FAR = "under $0.01 so far";

/** The sandbox list could not be read; the page and the drawer offer Retry. */
export const SANDBOX_LIST_FAILED = "Couldn't load your sandboxes.";

/** Today's cost; an amount too small to post reads `so far`, never `$0.00`. */
export function hoverTodayCost(mc: number): string {
  return `${formatSandboxCost(mc)} today`;
}

export function hoverSandboxIdentity(args: {
  readonly shape: string;
  readonly creator: string | null;
  readonly payer: string | null;
}): string {
  const parts = ["Sandbox", args.shape];
  if (args.creator !== null) parts.push(`started by ${args.creator}`);
  if (args.payer !== null) parts.push(`paid by ${args.payer}`);
  return parts.join(" · ");
}

export function hoverAgentIdentity(agent: string, payer: string): string {
  return `${AGENT_SANDBOX} · created by ${agent} for this task · paid by ${payer}`;
}

/**
 * Why a build without sandboxes (`unreleased-features.ts`) reaches no sandbox
 * control plane: the reason every sandbox read and write answers there.
 */
export const SANDBOXES_NOT_IN_THIS_BUILD =
  "Sandboxes are not available in this build.";
