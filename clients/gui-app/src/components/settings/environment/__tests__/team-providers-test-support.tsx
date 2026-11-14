/** Fixtures and queries shared by the team Providers page suites. */
import { fireEvent, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { EnvironmentConfigurationItem } from "@traycer/protocol/host/environment/configuration-contracts";
import type { ProviderCliState } from "@traycer/protocol/host/provider-schemas";
import type { SettingsSectionId } from "@/lib/settings-sections";
import { setSystemTabModalApi } from "@/stores/tabs/system-tab-modal-bridge";
import { configurationItem } from "./team-configuration-test-support";
import { DEFAULT_PROVIDER_NATIVE_CAPABILITIES } from "@traycer/protocol/host/provider-native-schemas";
import {
  RETIRED_PROVIDER_VARIABLES,
  RETIRED_SECRET_ROW_FIELDS,
} from "@traycer/protocol/host/released-wire-rows";

export const profile = (enabled: boolean, revision: number) =>
  configurationItem({
    kind: "managed_profile",
    key: "claude:prof-1",
    value: {
      name: "Work",
      color: null,
      harnessId: "claude",
      accountIdentity: "ada@example.com",
      needsLink: false,
      enabled,
      mergedInto: "kept-work",
    },
    revision,
  });

export const envOverride = (value: string, revision: number) =>
  configurationItem({
    kind: "env_override",
    key: "claude:ANTHROPIC_BASE_URL",
    os: "any",
    value: { value },
    revision,
  });

export const pack = (pinnedVersion: string | null, revision: number) =>
  configurationItem({
    kind: "pack_policy",
    key: "claude-pack",
    value: { pinnedVersion, autoDownload: true },
    revision,
  });

const environments = {
  environments: [
    {
      environmentId: "env-a",
      ownerKind: "organization" as const,
      ownerId: "team-a",
      roomId: "room-a",
      label: "Acme",
      effectiveRole: "editor" as const,
      kind: "team" as const,
      hostCount: 0,
      providerHandle: "handle-a",
    },
  ],
};

/** A `providers.list` row whose Env override only reaches Traycer's own
 *  native config (MCP setup), never the provider's conversations. Cursor's
 *  `envOverrideScope` is `native-config-only`. */
export function cursorProviderListRow(): ProviderCliState {
  return {
    providerId: "cursor",
    enabled: true,
    disabledBy: null,
    nativeCapabilities: {
      ...DEFAULT_PROVIDER_NATIVE_CAPABILITIES,
      envOverrideScope: "native-config-only",
    },
    selected: { kind: "bundled" },
    candidates: [],
    auth: { status: "unknown", badgeText: null, label: null, detail: null },
    authPending: false,
    checkedAt: null,
    apiKey: { supported: false, configured: false, source: null },
    terminalAgentArgs: "",
    envOverrides: [],
    loginCapability: null,
    availabilityPending: false,
    profiles: [],
  };
}

export const cursorProfile = (name: string, revision: number) =>
  configurationItem({
    kind: "managed_profile",
    key: `cursor:${name}`,
    value: {
      name,
      color: null,
      harnessId: "cursor",
      accountIdentity: null,
      needsLink: false,
      enabled: true,
    },
    revision,
  });

export const cursorKey = {
  secretId: "secret-cursor",
  name: "CURSOR_API_KEY",
  kind: "provider" as const,
  protocol: null,
  destinations: [],
  ...RETIRED_SECRET_ROW_FIELDS,
  providerVariables: [...RETIRED_PROVIDER_VARIABLES],
  currentVersionId: "v1",
  revoked: false,
  updatedAt: 1,
  variables: [],
};

export function publishSettingsApi(
  setSection: (section: SettingsSectionId) => void,
): void {
  setSystemTabModalApi({
    active: null,
    openSettings: () => undefined,
    openHistory: () => undefined,
    close: () => undefined,
    setSection,
    replaceOwnedSettingsRoute: () => undefined,
    promoteToTab: () => undefined,
    isOverlayActive: () => true,
  });
}

export function railButton(name: string): HTMLElement {
  const rail = screen.getByRole("navigation", { name: "Providers" });
  return within(rail).getByRole("button", { name: new RegExp(`^${name}`) });
}

/** Name and subtitle are sibling spans, so `textContent` has no space between them. */
export function railPieces(name: string): {
  title: string;
  subtitle: string | null;
} {
  const spans = [...railButton(name).querySelectorAll(":scope > span")];
  const title = (spans[0]?.textContent ?? "").replace(/\s+/g, " ").trim();
  const subtitle =
    spans.length < 2
      ? null
      : (spans[1]?.textContent ?? "").replace(/\s+/g, " ").trim();
  return { title, subtitle };
}

/**
 * The name a role query uses. An `aria-hidden` icon's SVG title is in
 * `textContent` and is not part of the name.
 */
export function accessibleName(element: HTMLElement): string {
  const clone = element.cloneNode(true);
  if (!(clone instanceof HTMLElement)) return "";
  for (const hidden of clone.querySelectorAll("[aria-hidden='true']")) {
    hidden.remove();
  }
  return clone.textContent.replace(/\s+/g, " ").trim();
}

export function teamProfile(input: {
  readonly key: string;
  readonly name: string;
  readonly revision: number;
  readonly enabled: boolean;
  readonly mergedInto: string;
  readonly accountIdentity: string | null;
  readonly color?: string | null;
}): EnvironmentConfigurationItem {
  return configurationItem({
    kind: "managed_profile",
    key: input.key,
    revision: input.revision,
    value: {
      name: input.name,
      color: input.color ?? null,
      harnessId: "claude",
      accountIdentity: input.accountIdentity,
      needsLink: false,
      enabled: input.enabled,
      mergedInto: input.mergedInto,
    },
  });
}

export function profileTriggerName(
  profileName: string,
  disabled: boolean,
): string {
  return disabled
    ? `Claude Code profile: ${profileName}, Disabled`
    : `Claude Code profile: ${profileName}`;
}

export function openProfileMenu(accessibleName: string): void {
  const trigger = screen.getByRole("button", { name: accessibleName });
  fireEvent.pointerDown(trigger);
  fireEvent.click(trigger);
}

export function profileRowSwitch(profileName: string): HTMLElement {
  return within(
    screen.getByRole("group", { name: `${profileName} profile controls` }),
  ).getByRole("switch", { name: `Allow agents to use ${profileName}` });
}

export async function openProfileEditor(): Promise<HTMLElement> {
  await userEvent.click(screen.getByRole("button", { name: "Manage profile" }));
  return screen.findByRole("dialog", { name: "Edit profile" });
}

export function handlers(items: () => EnvironmentConfigurationItem[]) {
  return {
    "environment.configuration.items": () => ({ items: items() }),
    "environment.list": () => environments,
    "environment.host.list": () => ({ hosts: [] }),
    "environment.plans.list": () => ({ plans: [] }),
    "environment.secrets.list": () => ({ secrets: [], removed: [] }),
    "environment.members": () => ({
      members: [],
      nextCursor: null,
      legacyRoleNoticeSeenAt: null,
      legacyMembers: [],
    }),
  } as const;
}
