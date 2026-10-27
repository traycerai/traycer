/** Shared evidence and words for a sandbox's configuration application. No values or native error text. */
export interface SandboxSettingsSteps {
  readonly applied: readonly string[];
  readonly notApplied: readonly string[];
}

export function sandboxSettingsFailureLine(name: string, configuration: string, reference: string): string {
  return `${name} is awake, but ${configuration}'s settings didn't apply · ${reference}`;
}

const STEP_LABELS: Readonly<Record<string, string>> = {
  secret: "Secrets",
  managed_profile: "Providers",
  env_override: "Providers",
  fallback_policy: "Providers",
  mcp_server: "MCP servers",
  skill: "Skills",
  agent_definition: "Agent definitions",
  setup_script: "Setup script",
  variable: "Variables",
  shell: "Shell",
  hook: "Hooks",
  browser_agent_access: "Browser access",
  agent_selection_guide: "Agent selection guide",
  team_policy: "Team policy",
  member: "Members",
};

export function sandboxSettingsSteps(items: readonly {readonly kind: string; readonly status: string}[]): SandboxSettingsSteps {
  const steps = new Map<string, boolean>();
  for (const item of items) {
    if (item.status === "not_used") continue;
    const label = STEP_LABELS[item.kind];
    if (label === undefined) continue;
    steps.set(label, (steps.get(label) ?? true) && item.status === "applied");
  }
  return {
    applied: [...steps].filter(([, applied]) => applied).map(([label]) => label),
    notApplied: [...steps].filter(([, applied]) => !applied).map(([label]) => label),
  };
}

function stepNames(names: readonly string[]): string {
  if (names.length < 2) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

export function sandboxSettingsStepsLine(steps: SandboxSettingsSteps): string {
  const applied = stepNames(steps.applied);
  const notApplied = stepNames(steps.notApplied);
  if (applied.length === 0) return notApplied.length === 0 ? "" : `${notApplied} did not apply.`;
  return notApplied.length === 0 ? `${applied} applied.` : `${applied} applied; ${notApplied} did not.`;
}

export function sandboxSettingsFailed(items: readonly {readonly status: string}[]): boolean {
  return items.some((item) => item.status === "failed" || item.status === "unsupported");
}
