import type { OsScript } from "@traycer/protocol/host/index";

/** Pure helpers + types for the per-OS setup/teardown script form, shared by worktree creation surfaces. */

export type OsForm = {
  readonly default: string;
  readonly macos: string;
  readonly windows: string;
  readonly linux: string;
};

export interface RepoScriptsValue {
  readonly setup: OsForm;
  readonly teardown: OsForm;
}

export type RepoScriptsSeed = {
  readonly setup: OsScript;
  readonly teardown: OsScript;
};

const EMPTY_OS_FORM: OsForm = {
  default: "",
  macos: "",
  windows: "",
  linux: "",
};

function scriptToOsForm(script: OsScript | undefined): OsForm {
  if (script === undefined) return EMPTY_OS_FORM;
  return {
    default: script.default,
    macos: script.macos ?? "",
    windows: script.windows ?? "",
    linux: script.linux ?? "",
  };
}

function osFormToScript(form: OsForm): OsScript {
  const orNull = (value: string) => (value.trim().length === 0 ? null : value);
  return {
    default: form.default,
    macos: orNull(form.macos),
    windows: orNull(form.windows),
    linux: orNull(form.linux),
  };
}

export function repoScriptsValueFromScripts(
  scripts: RepoScriptsSeed | null,
): RepoScriptsValue {
  return {
    setup: scriptToOsForm(scripts?.setup),
    teardown: scriptToOsForm(scripts?.teardown),
  };
}

export function repoScriptsRequestPayload(value: RepoScriptsValue): {
  readonly setup: OsScript;
  readonly teardown: OsScript;
} {
  return {
    setup: osFormToScript(value.setup),
    teardown: osFormToScript(value.teardown),
  };
}
