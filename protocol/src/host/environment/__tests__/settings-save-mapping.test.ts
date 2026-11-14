import { describe, expect, it } from "vitest";
import { upgradeRequestToVersion } from "@traycer/protocol/framework/versioned-rpc";
import { hostAccountSettingsRefreshV10 } from "@traycer/protocol/host/account-settings/contracts";
import {
  configShellAddRequestSchema,
  configShellAddUpgradeV11ToV12,
  configShellAddV12,
  configShellGetResponseSchema,
  configShellGetUpgradeV10ToV11,
  configShellGetV11,
  configShellRemoveRequestSchema,
  configShellRemoveUpgradeV11ToV12,
  configShellRemoveV12,
  configShellRevertArgsRequestSchema,
  configShellRevertArgsUpgradeV11ToV12,
  configShellRevertArgsV12,
  configShellSetRequestSchema,
  configShellSetUpgradeV11ToV12,
  configShellSetV12,
  type ConfigShellSelection,
} from "@traycer/protocol/host/config";
import { hostOsOfPlatform } from "@traycer/protocol/host/environment/host-os";
import {
  canonicalSettingValue,
  settingsSaveBaseAddress,
  settingsItemEditSchema,
  settingsSaveItemEdit,
  type SettingsSave,
  type SettingsSaveBase,
  type SettingsSaveMapping,
} from "@traycer/protocol/host/environment/settings-save-mapping";
import {
  environmentProposalsV10,
  readSettingsProposalRefusalReason,
} from "@traycer/protocol/host/environment/settings-proposals";
import { hostRpcRegistry } from "@traycer/protocol/host/index";
import {
  providersSetEnabledRequestSchemaV21,
  providersSetPackPolicyRequestSchema,
  providersUsePackVersionRequestSchema,
} from "@traycer/protocol/host/provider-schemas";
import {
  providersSetEnabledDowngradeV22ToV10,
  providersSetEnabledUpgradeV21ToV22,
  providersSetEnabledV22,
  providersSetPackPolicyUpgradeV10ToV11,
  providersSetPackPolicyV11,
  providersUsePackVersionUpgradeV11ToV12,
  providersUsePackVersionV12,
} from "@traycer/protocol/host/registry";

const LOCAL_ONLY: SettingsSaveMapping = { kind: "local_only" };

const EXACT_SHELL = { path: "/Bin/Zsh", args: ["-L", "-l", "-l"] };
const EXACT_SELECTION: ConfigShellSelection = {
  kind: "shell",
  path: EXACT_SHELL.path,
  args: EXACT_SHELL.args,
};
const EXACT_CANONICAL = '{"args":["-L","-l","-l"],"path":"/Bin/Zsh"}';

const emptyShellArgs: string[] = [];
const EMPTY_ARGS_SHELL = { path: "/bin/zsh", args: emptyShellArgs };
const EMPTY_ARGS_CANONICAL = '{"args":[],"path":"/bin/zsh"}';

const HOST_SHELL = { path: "/bin/zsh", args: ["-l"] };
const WAITING_SHELL = { path: "/usr/local/bin/Fish", args: ["--login"] };
const WAITING_SHELL_CANONICAL =
  '{"args":["--login"],"path":"/usr/local/bin/Fish"}';
const THIRD_SHELL = { path: "/bin/sh", args: ["-f"] };

const ORDERED: SettingsSaveBase = {
  rows: [
    { os: "windows", value: null },
    { os: "linux", value: null },
    { os: "macos", value: null },
  ],
  hostOs: "linux",
};

const EXACT_HELD: SettingsSaveBase = {
  rows: [{ os: "linux", value: EXACT_SHELL }],
  hostOs: "linux",
};

const EXACT_ANY: SettingsSaveBase = {
  rows: [{ os: "any", value: EXACT_SHELL }],
  hostOs: "linux",
};

const OTHER_OS_ROW: SettingsSaveBase = {
  rows: [{ os: "macos", value: null }],
  hostOs: "linux",
};

const EMPTY: SettingsSaveBase = { rows: [], hostOs: "linux" };

const UNKNOWN_HOST: SettingsSaveBase = {
  rows: [{ os: "linux", value: null }],
  hostOs: null,
};

const STATED_POLICY = { pinnedVersion: "1.2.3", autoDownload: false };
const STATED_POLICY_CANONICAL =
  '{"autoDownload":false,"pinnedVersion":"1.2.3"}';
const NULL_PIN_POLICY = { pinnedVersion: null, autoDownload: true };
const NULL_PIN_CANONICAL = '{"autoDownload":true,"pinnedVersion":null}';
const WAITING_POLICY = { pinnedVersion: "2.0.0", autoDownload: true };
const WAITING_POLICY_CANONICAL =
  '{"autoDownload":true,"pinnedVersion":"2.0.0"}';

const OTHER_PACK: SettingsSaveBase = {
  rows: [{ os: null, value: { pinnedVersion: "9.0.0", autoDownload: true } }],
  hostOs: "macos",
};

const EQUAL_PACK: SettingsSaveBase = {
  rows: [{ os: null, value: STATED_POLICY }],
  hostOs: "linux",
};

const WAITING_PACK: SettingsSaveBase = {
  rows: [{ os: null, value: { pinnedVersion: "9.0.0", autoDownload: false } }],
  hostOs: "linux",
};

const MANAGED_PROFILE = {
  name: "Work",
  color: "#3b82f6",
  harnessId: "claude",
  accountIdentity: "ada@example.com",
  needsLink: true,
  enabled: false,
  bindingVersion: 4,
  custodyVersion: 9,
  note: "kept",
};

const PROFILE_ROW: SettingsSaveBase = {
  rows: [{ os: null, value: MANAGED_PROFILE }],
  hostOs: "linux",
};

const RENAMED_PROFILE = { ...MANAGED_PROFILE, name: "Desk" };
const RECOLORED_PROFILE = { ...MANAGED_PROFILE, color: "#ec4899" };
const RENAMED_CANONICAL =
  '{"accountIdentity":"ada@example.com","bindingVersion":4,"color":"#3b82f6","custodyVersion":9,"enabled":false,"harnessId":"claude","name":"Desk","needsLink":true,"note":"kept"}';
const RECOLORED_CANONICAL =
  '{"accountIdentity":"ada@example.com","bindingVersion":4,"color":"#ec4899","custodyVersion":9,"enabled":false,"harnessId":"claude","name":"Work","needsLink":true,"note":"kept"}';

const MCP_SERVER = {
  transport: "http",
  offFor: ["codex"],
  toolToggles: {
    claude: { read: true, search: false },
    codex: { search: true },
  },
};

const MCP_TOGGLED = {
  transport: "http",
  offFor: ["codex"],
  toolToggles: {
    claude: { read: true, search: true },
    codex: { search: true },
  },
};

const MCP_TOGGLED_CANONICAL =
  '{"offFor":["codex"],"toolToggles":{"claude":{"read":true,"search":true},"codex":{"search":true}},"transport":"http"}';

const MCP_ROW: SettingsSaveBase = {
  rows: [{ os: null, value: MCP_SERVER }],
  hostOs: "linux",
};

const MCP_TOGGLED_ROW: SettingsSaveBase = {
  rows: [{ os: null, value: MCP_TOGGLED }],
  hostOs: "linux",
};

const LINUX_NULL: SettingsSaveBase = {
  rows: [{ os: "linux", value: null }],
  hostOs: "linux",
};

const LINUX_KEPT: SettingsSaveBase = {
  rows: [{ os: "linux", value: { value: "kept" } }],
  hostOs: "linux",
};

const ANY_KEPT: SettingsSaveBase = {
  rows: [{ os: "any", value: { value: "kept" } }],
  hostOs: "linux",
};

type ShellSaveMethod =
  | "config.shell.set"
  | "config.shell.add"
  | "config.shell.remove"
  | "config.shell.revertArgs";

const SHELL_METHODS: readonly ShellSaveMethod[] = [
  "config.shell.set",
  "config.shell.add",
  "config.shell.remove",
  "config.shell.revertArgs",
];

type PackMethod = "providers.usePackVersion" | "providers.setPackPolicy";

const PACK_METHODS: readonly PackMethod[] = [
  "providers.usePackVersion",
  "providers.setPackPolicy",
];

type StatedPolicy = {
  pinnedVersion: string | null;
  autoDownload: boolean;
};

function shellSave(
  method: ShellSaveMethod,
  selection: ConfigShellSelection,
): SettingsSave {
  switch (method) {
    case "config.shell.set":
      return {
        method,
        request: {
          path: "/bin/zsh",
          args: ["-l"],
          executableWriteGrant: null,
          selection,
        },
      };
    case "config.shell.add":
      return {
        method,
        request: {
          path: "/bin/zsh",
          executableWriteGrant: null,
          selection,
        },
      };
    case "config.shell.remove":
      return {
        method,
        request: {
          path: "/bin/zsh",
          executableWriteGrant: null,
          selection,
        },
      };
    case "config.shell.revertArgs":
      return {
        method,
        request: {
          path: "/bin/zsh",
          executableWriteGrant: null,
          selection,
        },
      };
  }
}

function shellReset(): SettingsSave {
  return {
    method: "config.shell.reset",
    request: { executableWriteGrant: null },
  };
}

function shellPut(
  os: "linux" | "any",
  value: { path: string; args: string[] },
  canonicalValue: string,
): SettingsSaveMapping {
  return {
    kind: "proposal",
    edit: {
      kind: "shell",
      key: "shell",
      os,
      operation: "put",
      value,
      canonicalValue,
    },
  };
}

function shellDelete(os: "linux" | "any"): SettingsSaveMapping {
  return {
    kind: "proposal",
    edit: {
      kind: "shell",
      key: "shell",
      os,
      operation: "delete",
      value: null,
      canonicalValue: null,
    },
  };
}

function expectEachShellMethod(
  selection: ConfigShellSelection,
  base: SettingsSaveBase,
  expected: SettingsSaveMapping,
): void {
  for (const method of SHELL_METHODS) {
    expect(settingsSaveItemEdit(shellSave(method, selection), base)).toEqual(
      expected,
    );
  }
}

function packSave(
  method: PackMethod,
  policy: StatedPolicy | null,
): SettingsSave {
  if (method === "providers.usePackVersion") {
    return {
      method,
      request: {
        packId: "traycer-cli",
        version: policy === null ? null : policy.pinnedVersion,
        policy,
      },
    };
  }
  return {
    method,
    request: {
      packId: "traycer-cli",
      autoDownload: policy === null ? false : policy.autoDownload,
      policy,
    },
  };
}

function packPut(
  policy: StatedPolicy,
  canonicalValue: string,
): SettingsSaveMapping {
  return {
    kind: "proposal",
    edit: {
      kind: "pack_policy",
      key: "traycer-cli",
      os: null,
      operation: "put",
      value: policy,
      canonicalValue,
    },
  };
}

function expectEachPackMethod(
  policy: StatedPolicy,
  base: SettingsSaveBase,
  expected: SettingsSaveMapping,
): void {
  for (const method of PACK_METHODS) {
    expect(settingsSaveItemEdit(packSave(method, policy), base)).toEqual(
      expected,
    );
  }
}

function renameSave(label: string): SettingsSave {
  return {
    method: "providers.setEnabled",
    request: {
      providerId: "claude-code",
      enabled: true,
      profileAction: {
        type: "rename",
        profileId: "profile-1",
        label,
        environmentProfileId: "env-profile-1",
      },
    },
  };
}

function recolorSave(accentColor: "#3b82f6" | "#ec4899"): SettingsSave {
  return {
    method: "providers.setEnabled",
    request: {
      providerId: "claude-code",
      enabled: true,
      profileAction: {
        type: "recolor",
        profileId: "profile-1",
        accentColor,
        environmentProfileId: "env-profile-1",
      },
    },
  };
}

function profilePut(
  value: typeof MANAGED_PROFILE,
  canonicalValue: string,
): SettingsSaveMapping {
  return {
    kind: "proposal",
    edit: {
      kind: "managed_profile",
      key: "claude:env-profile-1",
      os: null,
      operation: "put",
      value,
      canonicalValue,
    },
  };
}

function variablePut(os: "linux" | "any"): SettingsSaveMapping {
  return {
    kind: "proposal",
    edit: {
      kind: "variable",
      key: "DOCS_TOKEN",
      os,
      operation: "put",
      value: { value: "kept" },
      canonicalValue: '{"value":"kept"}',
    },
  };
}

function variableDelete(os: "linux" | "any"): SettingsSaveMapping {
  return {
    kind: "proposal",
    edit: {
      kind: "variable",
      key: "DOCS_TOKEN",
      os,
      operation: "delete",
      value: null,
      canonicalValue: null,
    },
  };
}

function envSet(value: string | null): SettingsSave {
  return {
    method: "config.env.set",
    request: {
      key: "DOCS_TOKEN",
      value,
      executableWriteGrant: null,
    },
  };
}

function envDelete(): SettingsSave {
  return {
    method: "config.env.delete",
    request: { key: "DOCS_TOKEN" },
  };
}

function overridePut(os: "linux" | "any"): SettingsSaveMapping {
  return {
    kind: "proposal",
    edit: {
      kind: "env_override",
      key: "claude-code:DOCS_TOKEN",
      os,
      operation: "put",
      value: { value: "kept" },
      canonicalValue: '{"value":"kept"}',
    },
  };
}

function overrideDelete(os: "linux" | "any"): SettingsSaveMapping {
  return {
    kind: "proposal",
    edit: {
      kind: "env_override",
      key: "claude-code:DOCS_TOKEN",
      os,
      operation: "delete",
      value: null,
      canonicalValue: null,
    },
  };
}

function overrideSet(value: string | null): SettingsSave {
  return {
    method: "providers.setEnvOverride",
    request: {
      providerId: "claude-code",
      key: "DOCS_TOKEN",
      value,
      executableWriteGrant: null,
    },
  };
}

function overrideDeleteSave(): SettingsSave {
  return {
    method: "providers.deleteEnvOverride",
    request: { providerId: "claude-code", key: "DOCS_TOKEN" },
  };
}

function toggleSave(enabled: boolean): SettingsSave {
  return {
    method: "providers.nativeMutate",
    request: {
      providerId: "claude-code",
      expectedEnvironmentId: null,
      executableWriteGrant: null,
      mutation: {
        kind: "mcp",
        scope: "global",
        workspaceRoot: null,
        mutation: {
          action: "toggleTool",
          serverName: "docs",
          toolName: "search",
          enabled,
        },
      },
    },
  };
}

function mcpRemoveSave(): SettingsSave {
  return {
    method: "providers.nativeMutate",
    request: {
      providerId: "claude-code",
      expectedEnvironmentId: null,
      executableWriteGrant: null,
      mutation: {
        kind: "mcp",
        scope: "global",
        workspaceRoot: null,
        mutation: { action: "remove", name: "docs" },
      },
    },
  };
}

describe("settingValueSchema through the item edit consumer", () => {
  it("parses JSON values and preserves z.json object-key behavior through put edits", () => {
    const put = (value: unknown) =>
      settingsItemEditSchema.parse({
        kind: "variable",
        key: "A",
        os: null,
        operation: "put",
        value,
        canonicalValue: "",
      });
    const values = [
      { nested: { enabled: true, items: [1, null, "x"] } },
      [1, "x", null],
      null,
      7,
      "value",
    ];
    for (const value of values) {
      expect(put(value).value).toEqual(value);
    }
    expect(() => put({ a: undefined })).toThrow();
    expect(() => put(() => "value")).toThrow();
    expect(() => put(Number.NaN)).toThrow();
    expect(put(JSON.parse('{"__proto__":{"x":1},"y":2}')).value).toEqual({
      y: 2,
    });
  });
});

describe("settingsSaveItemEdit", () => {
  describe("shell", () => {
    it("puts the stated shell on the host OS row, keeping path, args, case and duplicates", () => {
      expectEachShellMethod(
        EXACT_SELECTION,
        ORDERED,
        shellPut("linux", EXACT_SHELL, EXACT_CANONICAL),
      );
    });

    it("leaves a stated shell that equals the host OS row local_only", () => {
      expectEachShellMethod(EXACT_SELECTION, EXACT_HELD, LOCAL_ONLY);
    });

    it("compares a shell row independently of object key order", () => {
      expect(
        settingsSaveItemEdit(shellSave("config.shell.set", EXACT_SELECTION), {
          rows: [
            {
              os: "linux",
              value: { args: EXACT_SHELL.args, path: EXACT_SHELL.path },
            },
          ],
          hostOs: "linux",
        }),
      ).toEqual(LOCAL_ONLY);
    });

    it("puts empty args when the base shell has no args field", () => {
      expect(
        settingsSaveItemEdit(
          shellSave("config.shell.set", {
            kind: "shell",
            path: EMPTY_ARGS_SHELL.path,
            args: EMPTY_ARGS_SHELL.args,
          }),
          {
            rows: [{ os: "linux", value: { path: "/bin/zsh" } }],
            hostOs: "linux",
          },
        ),
      ).toEqual(shellPut("linux", EMPTY_ARGS_SHELL, EMPTY_ARGS_CANONICAL));
    });

    it("puts when the shell argument order differs", () => {
      expect(
        settingsSaveItemEdit(shellSave("config.shell.set", EXACT_SELECTION), {
          rows: [
            {
              os: "linux",
              value: {
                path: EXACT_SHELL.path,
                args: [...EXACT_SHELL.args].reverse(),
              },
            },
          ],
          hostOs: "linux",
        }),
      ).toEqual(shellPut("linux", EXACT_SHELL, EXACT_CANONICAL));
    });

    it("puts when shell argument case differs", () => {
      expect(
        settingsSaveItemEdit(shellSave("config.shell.set", EXACT_SELECTION), {
          rows: [
            {
              os: "linux",
              value: { path: EXACT_SHELL.path, args: ["-l", "-l", "-l"] },
            },
          ],
          hostOs: "linux",
        }),
      ).toEqual(shellPut("linux", EXACT_SHELL, EXACT_CANONICAL));
    });

    it("compares the host OS row when both any and host rows exist", () => {
      expect(
        settingsSaveItemEdit(shellSave("config.shell.set", EXACT_SELECTION), {
          rows: [
            { os: "any", value: HOST_SHELL },
            { os: "linux", value: { path: "/bin/sh", args: [] } },
          ],
          hostOs: "linux",
        }),
      ).toEqual(shellPut("linux", EXACT_SHELL, EXACT_CANONICAL));
    });

    it("puts an empty argument list on the host OS row", () => {
      expectEachShellMethod(
        {
          kind: "shell",
          path: EMPTY_ARGS_SHELL.path,
          args: EMPTY_ARGS_SHELL.args,
        },
        LINUX_NULL,
        shellPut("linux", EMPTY_ARGS_SHELL, EMPTY_ARGS_CANONICAL),
      );
    });

    it("deletes the host OS row for the system default and leaves a missing target local_only", () => {
      expectEachShellMethod(
        { kind: "system_default" },
        ORDERED,
        shellDelete("linux"),
      );
      expectEachShellMethod(
        { kind: "system_default" },
        OTHER_OS_ROW,
        LOCAL_ONLY,
      );
    });

    it("expects nothing when the selection is not stated", () => {
      expectEachShellMethod({ kind: "not_stated" }, ORDERED, LOCAL_ONLY);
    });

    it("puts the stated shell on any when the host OS has no row", () => {
      const onAny = shellPut("any", EXACT_SHELL, EXACT_CANONICAL);
      expect(
        settingsSaveItemEdit(
          shellSave("config.shell.set", EXACT_SELECTION),
          OTHER_OS_ROW,
        ),
      ).toEqual(onAny);
      expect(
        settingsSaveItemEdit(
          shellSave("config.shell.set", EXACT_SELECTION),
          EMPTY,
        ),
      ).toEqual(onAny);
    });

    it("leaves a stated shell that equals the any row local_only when the host OS has no row", () => {
      expect(
        settingsSaveItemEdit(
          shellSave("config.shell.set", EXACT_SELECTION),
          EXACT_ANY,
        ),
      ).toEqual(LOCAL_ONLY);
    });

    it("is unmapped when the host OS is not known", () => {
      expect(
        settingsSaveItemEdit(
          shellSave("config.shell.set", EXACT_SELECTION),
          UNKNOWN_HOST,
        ),
      ).toEqual({ kind: "unmapped", reason: "host_os_unknown" });
    });

    it("proposes the stated shell selection", () => {
      const hostShell = { path: HOST_SHELL.path, args: HOST_SHELL.args };
      expect(
        settingsSaveItemEdit(
          shellSave("config.shell.set", {
            kind: "shell",
            path: hostShell.path,
            args: hostShell.args,
          }),
          {
            rows: [{ os: "linux", value: THIRD_SHELL }],
            hostOs: "linux",
          },
        ),
      ).toEqual(
        shellPut("linux", hostShell, '{"args":["-l"],"path":"/bin/zsh"}'),
      );
    });

    it("proposes the stated shell selection when it differs from the base", () => {
      expect(
        settingsSaveItemEdit(
          shellSave("config.shell.set", {
            kind: "shell",
            path: WAITING_SHELL.path,
            args: WAITING_SHELL.args,
          }),
          { rows: [{ os: "linux", value: THIRD_SHELL }], hostOs: "linux" },
        ),
      ).toEqual(shellPut("linux", WAITING_SHELL, WAITING_SHELL_CANONICAL));
    });

    it("deletes the host OS row on reset and leaves a missing row local_only", () => {
      expect(settingsSaveItemEdit(shellReset(), ORDERED)).toEqual(
        shellDelete("linux"),
      );
      expect(settingsSaveItemEdit(shellReset(), EMPTY)).toEqual(LOCAL_ONLY);
    });
  });

  describe("pack policy", () => {
    it("puts a stated policy the base does not hold", () => {
      expectEachPackMethod(
        STATED_POLICY,
        OTHER_PACK,
        packPut(STATED_POLICY, STATED_POLICY_CANONICAL),
      );
    });

    it("leaves a stated policy that equals the base row local_only", () => {
      expectEachPackMethod(STATED_POLICY, EQUAL_PACK, LOCAL_ONLY);
    });

    it("puts a stated policy whose pin is null", () => {
      expect(
        settingsSaveItemEdit(
          packSave("providers.usePackVersion", NULL_PIN_POLICY),
          EMPTY,
        ),
      ).toEqual(packPut(NULL_PIN_POLICY, NULL_PIN_CANONICAL));
    });

    it("expects nothing when the pack policy is not stated", () => {
      expect(
        settingsSaveItemEdit(
          packSave("providers.setPackPolicy", null),
          OTHER_PACK,
        ),
      ).toEqual(LOCAL_ONLY);
    });

    it("proposes the stated policy when it differs from the base", () => {
      expect(
        settingsSaveItemEdit(
          packSave("providers.setPackPolicy", WAITING_POLICY),
          WAITING_PACK,
        ),
      ).toEqual(packPut(WAITING_POLICY, WAITING_POLICY_CANONICAL));
    });

    it("leaves an older usePackVersion caller local_only after upgrading its request", () => {
      const request = providersUsePackVersionUpgradeV11ToV12.upgradeRequest({
        packId: "traycer-cli",
        version: "1.2.3",
      });
      expect(
        settingsSaveItemEdit(
          { method: "providers.usePackVersion", request },
          OTHER_PACK,
        ),
      ).toEqual(LOCAL_ONLY);
    });
  });

  describe("profile", () => {
    it("puts the held profile with only the name replaced", () => {
      const save = renameSave("Desk");
      const requestBefore = structuredClone(save.request);
      const baseBefore = structuredClone(PROFILE_ROW);
      expect(settingsSaveItemEdit(save, PROFILE_ROW)).toEqual(
        profilePut(RENAMED_PROFILE, RENAMED_CANONICAL),
      );
      expect(save.request).toEqual(requestBefore);
      expect(PROFILE_ROW).toEqual(baseBefore);
    });

    it("puts the held profile with only the color replaced", () => {
      expect(settingsSaveItemEdit(recolorSave("#ec4899"), PROFILE_ROW)).toEqual(
        profilePut(RECOLORED_PROFILE, RECOLORED_CANONICAL),
      );
    });

    it("keeps an own __proto__ profile field when proposing a rename", () => {
      const baseProfile = JSON.parse(
        '{"__proto__":"own","name":"Work","color":"#3b82f6","harnessId":"claude","accountIdentity":"ada@example.com","needsLink":true,"enabled":false,"bindingVersion":4,"custodyVersion":9,"note":"kept"}',
      );
      expect(
        settingsSaveItemEdit(renameSave("Desk"), {
          rows: [{ os: null, value: baseProfile }],
          hostOs: "linux",
        }),
      ).toEqual({
        kind: "proposal",
        edit: {
          kind: "managed_profile",
          key: "claude:env-profile-1",
          os: null,
          operation: "put",
          value: { ...baseProfile, name: "Desk" },
          canonicalValue:
            '{"__proto__":"own","accountIdentity":"ada@example.com","bindingVersion":4,"color":"#3b82f6","custodyVersion":9,"enabled":false,"harnessId":"claude","name":"Desk","needsLink":true,"note":"kept"}',
        },
      });
    });

    it("puts a pack policy when a null field is absent from the base", () => {
      expect(
        settingsSaveItemEdit(
          packSave("providers.usePackVersion", NULL_PIN_POLICY),
          {
            rows: [{ os: null, value: { autoDownload: true } }],
            hostOs: "linux",
          },
        ),
      ).toEqual(packPut(NULL_PIN_POLICY, NULL_PIN_CANONICAL));
    });

    it("leaves a recolor with no environment profile id local_only", () => {
      expect(
        settingsSaveItemEdit(
          {
            method: "providers.setEnabled",
            request: {
              providerId: "claude-code",
              enabled: true,
              profileAction: {
                type: "recolor",
                profileId: "profile-1",
                accentColor: "#ec4899",
                environmentProfileId: null,
              },
            },
          },
          PROFILE_ROW,
        ),
      ).toEqual(LOCAL_ONLY);
    });

    it("keeps a recolor from an older caller local_only after upgrading its request", () => {
      const recolor = {
        providerId: "claude-code" as const,
        enabled: false,
        profileAction: {
          type: "recolor" as const,
          profileId: "profile-1",
          accentColor: "#3b82f6" as const,
        },
      };
      const recolorUpgraded =
        providersSetEnabledUpgradeV21ToV22.upgradeRequest(recolor);
      expect(
        settingsSaveItemEdit(
          { method: "providers.setEnabled", request: recolorUpgraded },
          PROFILE_ROW,
        ),
      ).toEqual(LOCAL_ONLY);
    });

    it("proposes the browser access setting", () => {
      expect(
        settingsSaveItemEdit(
          { method: "config.browser.set", request: { agentAccess: true } },
          EMPTY,
        ),
      ).toEqual({
        kind: "proposal",
        edit: {
          kind: "browser_agent_access",
          key: "browser",
          os: null,
          operation: "put",
          value: { enabled: true },
          canonicalValue: '{"enabled":true}',
        },
      });
    });

    it("proposes the agent memories setting", () => {
      expect(
        settingsSaveItemEdit(
          {
            method: "config.agentMemories.set",
            request: { enabled: false },
          },
          EMPTY,
        ),
      ).toEqual({
        kind: "proposal",
        edit: {
          kind: "agent_memory",
          key: "memory",
          os: null,
          operation: "put",
          value: { enabled: false },
          canonicalValue: '{"enabled":false}',
        },
      });
    });

    it("proposes the fallback policy setting", () => {
      expect(
        settingsSaveItemEdit(
          {
            method: "providers.fallbackPolicy.set",
            request: {
              policy: {
                enabled: true,
                ladder: [],
                graceWindowSeconds: 30,
                maxWaitMinutes: 60,
                returnToPreferred: "prompt",
                tierGroups: [],
                defaultTierGroupId: null,
              },
            },
          },
          EMPTY,
        ),
      ).toEqual({
        kind: "proposal",
        edit: {
          kind: "fallback_policy",
          key: "fallback",
          os: null,
          operation: "put",
          value: {
            document: {
              enabled: true,
              ladder: [],
              graceWindowSeconds: 30,
              maxWaitMinutes: 60,
              returnToPreferred: "prompt",
              tierGroups: [],
              defaultTierGroupId: null,
            },
          },
          canonicalValue:
            '{"document":{"defaultTierGroupId":null,"enabled":true,"graceWindowSeconds":30,"ladder":[],"maxWaitMinutes":60,"returnToPreferred":"prompt","tierGroups":[]}}',
        },
      });
    });

    it("proposes the environment setup script", () => {
      expect(
        settingsSaveItemEdit(
          {
            method: "environment.setup.put",
            request: {
              os: "linux",
              text: "echo setup",
              expectedRevision: null,
              executableWriteGrant: null,
            },
          },
          EMPTY,
        ),
      ).toEqual({
        kind: "proposal",
        edit: {
          kind: "setup_script",
          key: "setup",
          os: "linux",
          operation: "put",
          value: { text: "echo setup" },
          canonicalValue: '{"text":"echo setup"}',
        },
      });
    });

    it("proposes the environment agent definition", () => {
      expect(
        settingsSaveItemEdit(
          {
            method: "environment.agentDefinitions.put",
            request: {
              name: "reviewer",
              text: "Review the change.",
              expectedRevision: null,
              executableWriteGrant: null,
            },
          },
          EMPTY,
        ),
      ).toEqual({
        kind: "proposal",
        edit: {
          kind: "agent_definition",
          key: "reviewer",
          os: null,
          operation: "put",
          value: { text: "Review the change." },
          canonicalValue: '{"text":"Review the change."}',
        },
      });
    });

    it("rename to the base's own name leaves the whole item unchanged, so local_only (the form lays over the base, so no other field can differ)", () => {
      expect(settingsSaveItemEdit(renameSave("Work"), PROFILE_ROW)).toEqual(
        LOCAL_ONLY,
      );
    });

    it("recolor to the base's own color leaves the whole item unchanged, so local_only (the form lays over the base, so no other field can differ)", () => {
      expect(settingsSaveItemEdit(recolorSave("#3b82f6"), PROFILE_ROW)).toEqual(
        LOCAL_ONLY,
      );
    });

    it("expects nothing when a rename names no environment profile", () => {
      expect(
        settingsSaveItemEdit(
          {
            method: "providers.setEnabled",
            request: {
              providerId: "claude-code",
              enabled: true,
              profileAction: {
                type: "rename",
                profileId: "profile-1",
                label: "Desk",
                environmentProfileId: null,
              },
            },
          },
          PROFILE_ROW,
        ),
      ).toEqual(LOCAL_ONLY);
    });

    it("expects nothing when the environment holds no profile row", () => {
      expect(settingsSaveItemEdit(recolorSave("#ec4899"), EMPTY)).toEqual(
        LOCAL_ONLY,
      );
    });

    it("expects nothing when the profile row is not an object", () => {
      expect(
        settingsSaveItemEdit(renameSave("Desk"), {
          rows: [{ os: null, value: "held" }],
          hostOs: "linux",
        }),
      ).toEqual(LOCAL_ONLY);
    });

    it("expects nothing when the profile action acknowledges drift", () => {
      expect(
        settingsSaveItemEdit(
          {
            method: "providers.setEnabled",
            request: {
              providerId: "claude-code",
              enabled: true,
              profileAction: { type: "acknowledgeAmbientDrift" },
            },
          },
          PROFILE_ROW,
        ),
      ).toEqual(LOCAL_ONLY);
    });

    it("is unmapped when the profile is removed", () => {
      expect(
        settingsSaveItemEdit(
          {
            method: "providers.setEnabled",
            request: {
              providerId: "claude-code",
              enabled: false,
              profileAction: { type: "remove", profileId: "profile-1" },
            },
          },
          PROFILE_ROW,
        ),
      ).toEqual({ kind: "unmapped", reason: "key_from_host_state" });
    });
  });

  describe("variable", () => {
    it("puts a different variable on the host OS, or on any when that OS has no row", () => {
      expect(settingsSaveItemEdit(envSet("kept"), LINUX_NULL)).toEqual(
        variablePut("linux"),
      );
      expect(settingsSaveItemEdit(envSet("kept"), LINUX_KEPT)).toEqual(
        LOCAL_ONLY,
      );
      expect(settingsSaveItemEdit(envSet("kept"), OTHER_OS_ROW)).toEqual(
        variablePut("any"),
      );
    });

    it("deletes a variable on the row it targets, keeps a null variable local_only, and leaves a missing target local_only", () => {
      expect(settingsSaveItemEdit(envDelete(), LINUX_NULL)).toEqual(
        variableDelete("linux"),
      );
      // A null value is not a delete: it masks the variable on this host only.
      expect(settingsSaveItemEdit(envSet(null), LINUX_NULL)).toEqual(
        LOCAL_ONLY,
      );
      expect(settingsSaveItemEdit(envDelete(), ANY_KEPT)).toEqual(
        variableDelete("any"),
      );
      expect(settingsSaveItemEdit(envDelete(), EMPTY)).toEqual(LOCAL_ONLY);
    });
  });

  describe("env override", () => {
    it("puts a different override on the host OS row and leaves an equal one local_only", () => {
      expect(settingsSaveItemEdit(overrideSet("kept"), LINUX_NULL)).toEqual(
        overridePut("linux"),
      );
      expect(settingsSaveItemEdit(overrideSet("kept"), LINUX_KEPT)).toEqual(
        LOCAL_ONLY,
      );
    });

    it("deletes an override on the host OS row, keeps a null override local_only, and leaves a missing row local_only", () => {
      expect(settingsSaveItemEdit(overrideDeleteSave(), LINUX_NULL)).toEqual(
        overrideDelete("linux"),
      );
      // A null value is not a delete: it masks the override on this host only.
      expect(settingsSaveItemEdit(overrideSet(null), LINUX_NULL)).toEqual(
        LOCAL_ONLY,
      );
      expect(settingsSaveItemEdit(overrideDeleteSave(), EMPTY)).toEqual(
        LOCAL_ONLY,
      );
    });
  });

  describe("native mutate", () => {
    it("merges a global tool toggle into the server row and leaves the request and the base unchanged", () => {
      const save = toggleSave(true);
      const requestBefore = structuredClone(save.request);
      const baseBefore = structuredClone(MCP_ROW);
      expect(settingsSaveItemEdit(save, MCP_ROW)).toEqual({
        kind: "proposal",
        edit: {
          kind: "mcp_server",
          key: "docs",
          os: null,
          operation: "put",
          value: MCP_TOGGLED,
          canonicalValue: MCP_TOGGLED_CANONICAL,
        },
      });
      expect(save.request).toEqual(requestBefore);
      expect(MCP_ROW).toEqual(baseBefore);
    });

    it("leaves a tool toggle that equals the whole server row local_only", () => {
      expect(settingsSaveItemEdit(toggleSave(true), MCP_TOGGLED_ROW)).toEqual(
        LOCAL_ONLY,
      );
    });

    it("deletes an mcp server when the environment holds its row and expects nothing when it does not", () => {
      expect(settingsSaveItemEdit(mcpRemoveSave(), MCP_ROW)).toEqual({
        kind: "proposal",
        edit: {
          kind: "mcp_server",
          key: "docs",
          os: null,
          operation: "delete",
          value: null,
          canonicalValue: null,
        },
      });
      expect(settingsSaveItemEdit(mcpRemoveSave(), EMPTY)).toEqual(LOCAL_ONLY);
    });

    it("retires a skill removed from global settings", () => {
      expect(
        settingsSaveItemEdit(
          {
            method: "providers.nativeMutate",
            request: {
              providerId: "claude-code",
              expectedEnvironmentId: null,
              executableWriteGrant: null,
              mutation: {
                kind: "skills",
                scope: "global",
                workspaceRoot: null,
                mutation: {
                  action: "remove",
                  name: "review",
                  path: "/skills/review",
                },
              },
            },
          },
          EMPTY,
        ),
      ).toEqual({ kind: "retired_item_delete" });
    });

    it("marks promoting an mcp server", () => {
      expect(
        settingsSaveItemEdit(
          {
            method: "providers.nativeMutate",
            request: {
              providerId: "claude-code",
              expectedEnvironmentId: null,
              executableWriteGrant: null,
              mutation: {
                kind: "promoteToPersonal",
                entryKind: "mcp",
                scope: "global",
                workspaceRoot: null,
                name: "docs",
              },
            },
          },
          EMPTY,
        ),
      ).toEqual({ kind: "mcp_promotion" });
    });
  });

  describe("agent definition", () => {
    it("deletes an agent definition when the environment holds no row", () => {
      expect(
        settingsSaveItemEdit(
          {
            method: "environment.agentDefinitions.delete",
            request: { name: "reviewer", expectedRevision: 3 },
          },
          EMPTY,
        ),
      ).toEqual({
        kind: "proposal",
        edit: {
          kind: "agent_definition",
          key: "reviewer",
          os: null,
          operation: "delete",
          value: null,
          canonicalValue: null,
        },
      });
    });
  });
});

describe("settingsSaveBaseAddress", () => {
  it("names the shell item for set, add, remove and revertArgs", () => {
    for (const method of SHELL_METHODS) {
      expect(
        settingsSaveBaseAddress(shellSave(method, { kind: "not_stated" })),
      ).toEqual({ kind: "shell", key: "shell" });
    }
  });

  it("names a claude-code profile by the claude harness id", () => {
    expect(settingsSaveBaseAddress(renameSave("Desk"))).toEqual({
      kind: "managed_profile",
      key: "claude:env-profile-1",
    });
  });
});

describe("canonicalSettingValue", () => {
  it("uses one text when the same object is written with its keys in another order", () => {
    const text = '{"alpha":{"aye":null,"bee":false},"zeta":1}';
    expect(
      canonicalSettingValue({ zeta: 1, alpha: { bee: false, aye: null } }),
    ).toEqual(text);
    expect(
      canonicalSettingValue({ alpha: { aye: null, bee: false }, zeta: 1 }),
    ).toEqual(text);
  });

  it("sorts numeric-looking keys by code unit", () => {
    // Integer-index keys enumerate in numeric order. The canonical text sorts
    // by code unit, so "10" precedes "9".
    expect(canonicalSettingValue(JSON.parse('{"9":2,"10":1}'))).toEqual(
      '{"10":1,"9":2}',
    );
  });

  it("keeps an own __proto__ key", () => {
    // JSON.parse defines an own `__proto__` key. An object literal would not.
    expect(canonicalSettingValue(JSON.parse('{"__proto__":true}'))).toEqual(
      '{"__proto__":true}',
    );
    expect(canonicalSettingValue(JSON.parse('{"__proto__":false}'))).toEqual(
      '{"__proto__":false}',
    );
  });

  it("keeps an own constructor key and an own prototype key", () => {
    expect(canonicalSettingValue(JSON.parse('{"constructor":1}'))).toEqual(
      '{"constructor":1}',
    );
    expect(canonicalSettingValue(JSON.parse('{"prototype":false}'))).toEqual(
      '{"prototype":false}',
    );
  });

  it("keeps array order and the case of each element", () => {
    expect(canonicalSettingValue(["A", "b"])).toEqual('["A","b"]');
    expect(canonicalSettingValue(["b", "A"])).toEqual('["b","A"]');
    expect(canonicalSettingValue(["a", "b"])).toEqual('["a","b"]');
  });
});

describe("hostOsOfPlatform", () => {
  it("reads the host OS from the platform before the first hyphen", () => {
    const rows: readonly (readonly [
      string | null,
      "linux" | "macos" | "windows" | null,
    ])[] = [
      ["darwin", "macos"],
      ["darwin-arm64", "macos"],
      ["darwin-x64", "macos"],
      ["linux", "linux"],
      ["linux-arm64", "linux"],
      ["linux-x64", "linux"],
      ["win32", "windows"],
      ["win32-arm64", "windows"],
      ["win32-x64", "windows"],
      ["freebsd", null],
      [null, null],
      ["", null],
      ["-darwin", null],
      ["macos", null],
    ];
    for (const [platform, hostOs] of rows) {
      expect(hostOsOfPlatform(platform)).toEqual(hostOs);
    }
  });
});

describe("version bridges", () => {
  it("states no shell selection when a 1.1 shell save is read as 1.2", () => {
    const set = {
      path: "/bin/zsh",
      args: ["-l"],
      executableWriteGrant: null,
    };
    const setUpgraded = configShellSetUpgradeV11ToV12.upgradeRequest(set);
    expect(setUpgraded).toEqual({ ...set, selection: { kind: "not_stated" } });
    expect(configShellSetRequestSchema.parse(setUpgraded)).toEqual(set);

    const add = { path: "/bin/zsh", executableWriteGrant: null };
    const addUpgraded = configShellAddUpgradeV11ToV12.upgradeRequest(add);
    expect(addUpgraded).toEqual({ ...add, selection: { kind: "not_stated" } });
    expect(configShellAddRequestSchema.parse(addUpgraded)).toEqual(add);

    const remove = { path: "/bin/zsh", executableWriteGrant: null };
    const removeUpgraded =
      configShellRemoveUpgradeV11ToV12.upgradeRequest(remove);
    expect(removeUpgraded).toEqual({
      ...remove,
      selection: { kind: "not_stated" },
    });
    expect(configShellRemoveRequestSchema.parse(removeUpgraded)).toEqual(
      remove,
    );

    const revert = { path: "/bin/zsh", executableWriteGrant: null };
    const revertUpgraded =
      configShellRevertArgsUpgradeV11ToV12.upgradeRequest(revert);
    expect(revertUpgraded).toEqual({
      ...revert,
      selection: { kind: "not_stated" },
    });
    expect(configShellRevertArgsRequestSchema.parse(revertUpgraded)).toEqual(
      revert,
    );
  });

  it("states no pack policy when an older pack save is read as the newer minor", () => {
    const usePack = { packId: "traycer-cli", version: "1.2.3" };
    const usePackUpgraded =
      providersUsePackVersionUpgradeV11ToV12.upgradeRequest(usePack);
    expect(usePackUpgraded).toEqual({ ...usePack, policy: null });
    expect(providersUsePackVersionRequestSchema.parse(usePackUpgraded)).toEqual(
      usePack,
    );

    const setPolicy = { packId: "traycer-cli", autoDownload: true };
    const setPolicyUpgraded =
      providersSetPackPolicyUpgradeV10ToV11.upgradeRequest(setPolicy);
    expect(setPolicyUpgraded).toEqual({ ...setPolicy, policy: null });
    expect(
      providersSetPackPolicyRequestSchema.parse(setPolicyUpgraded),
    ).toEqual(setPolicy);
  });

  it("answers no remembered shells when a 1.0 shell get is read as 1.1", () => {
    const response = { path: "/bin/zsh", args: ["-l"], synthesised: false };
    const upgraded = configShellGetUpgradeV10ToV11.upgradeResponse(response);
    expect(upgraded).toEqual({ ...response, entries: [] });
    expect(configShellGetResponseSchema.parse(upgraded)).toEqual(response);
  });

  it("names no environment profile when a 2.1 profile action is read as 2.2", () => {
    const rename = {
      providerId: "claude-code" as const,
      enabled: false,
      profileAction: {
        type: "rename" as const,
        profileId: "profile-1",
        label: "Desk",
      },
    };
    const renameUpgraded =
      providersSetEnabledUpgradeV21ToV22.upgradeRequest(rename);
    expect(renameUpgraded).toEqual({
      providerId: "claude-code",
      enabled: false,
      profileAction: {
        type: "rename",
        profileId: "profile-1",
        label: "Desk",
        environmentProfileId: null,
      },
    });
    expect(providersSetEnabledRequestSchemaV21.parse(renameUpgraded)).toEqual(
      rename,
    );

    const recolor = {
      providerId: "claude-code" as const,
      enabled: false,
      profileAction: {
        type: "recolor" as const,
        profileId: "profile-1",
        accentColor: "#3b82f6" as const,
      },
    };
    const recolorUpgraded =
      providersSetEnabledUpgradeV21ToV22.upgradeRequest(recolor);
    expect(recolorUpgraded).toEqual({
      providerId: "claude-code",
      enabled: false,
      profileAction: {
        type: "recolor",
        profileId: "profile-1",
        accentColor: "#3b82f6",
        environmentProfileId: null,
      },
    });
    expect(providersSetEnabledRequestSchemaV21.parse(recolorUpgraded)).toEqual(
      recolor,
    );

    const remove = {
      providerId: "claude-code" as const,
      enabled: false,
      profileAction: { type: "remove" as const, profileId: "profile-1" },
    };
    expect(providersSetEnabledUpgradeV21ToV22.upgradeRequest(remove)).toEqual(
      remove,
    );

    const acknowledge = {
      providerId: "claude-code" as const,
      enabled: false,
      profileAction: { type: "acknowledgeAmbientDrift" as const },
    };
    expect(
      providersSetEnabledUpgradeV21ToV22.upgradeRequest(acknowledge),
    ).toEqual(acknowledge);

    const plain = {
      providerId: "claude-code" as const,
      enabled: true,
      profileAction: null,
    };
    expect(providersSetEnabledUpgradeV21ToV22.upgradeRequest(plain)).toEqual(
      plain,
    );
  });

  it("drops the profile action when a 2.2 enable save is read as 1.0", () => {
    expect(
      providersSetEnabledDowngradeV22ToV10.downgradeRequest({
        providerId: "claude-code",
        enabled: true,
        profileAction: {
          type: "rename",
          profileId: "profile-1",
          label: "Desk",
          environmentProfileId: "env-profile-1",
        },
      }),
    ).toEqual({
      ok: true,
      value: { providerId: "claude-code", enabled: true },
    });
    expect(
      providersSetEnabledDowngradeV22ToV10.downgradeRequest({
        providerId: "grok",
        enabled: true,
        profileAction: null,
      }),
    ).toEqual({
      ok: false,
      error: {
        code: "DOWNGRADE_UNSUPPORTED",
        message: "Provider grok is not available in providers.*@1.0",
      },
    });
  });
});

describe("stated-item contracts", () => {
  it("parses the v1.1 shell get response entries and requires entries", () => {
    const response = {
      path: "/bin/zsh",
      args: ["-l"],
      synthesised: false,
      entries: [
        { path: "/bin/bash", args: null },
        { path: "/bin/fish", args: [] },
      ],
    };
    expect(configShellGetV11.responseSchema.parse(response)).toEqual(response);
    expect(() =>
      configShellGetV11.responseSchema.parse({
        path: "/bin/zsh",
        args: ["-l"],
        synthesised: false,
      }),
    ).toThrow();
  });

  it("parses v2.2 rename and recolor ids and requires the rename id", () => {
    const rename = {
      providerId: "claude-code" as const,
      enabled: true,
      profileAction: {
        type: "rename" as const,
        profileId: "profile-1",
        label: "Desk",
        environmentProfileId: "env-profile-1",
      },
    };
    const recolor = {
      providerId: "claude-code" as const,
      enabled: true,
      profileAction: {
        type: "recolor" as const,
        profileId: "profile-1",
        accentColor: "#ec4899" as const,
        environmentProfileId: "env-profile-2",
      },
    };
    expect(providersSetEnabledV22.requestSchema.parse(rename)).toEqual(rename);
    expect(providersSetEnabledV22.requestSchema.parse(recolor)).toEqual(
      recolor,
    );
    expect(() =>
      providersSetEnabledV22.requestSchema.parse({
        ...rename,
        profileAction: {
          type: "rename",
          profileId: "profile-1",
          label: "Desk",
        },
      }),
    ).toThrow();
  });

  it("projects a valid v2.2 setEnabled response to the v1.0 response", () => {
    const state = {
      providerId: "claude-code" as const,
      enabled: true,
      disabledBy: null,
      selected: { kind: "bundled" as const },
      candidates: [],
      authPending: false,
      checkedAt: null,
      apiKey: { supported: false, configured: false, source: null },
      terminalAgentArgs: "",
      envOverrides: [],
      loginCapability: null,
      auth: {
        status: "unknown" as const,
        badgeText: null,
        label: null,
        detail: null,
      },
      availabilityPending: false,
      profiles: [],
    };
    const response = providersSetEnabledV22.responseSchema.parse({ state });
    expect(
      providersSetEnabledDowngradeV22ToV10.downgradeResponse(response),
    ).toEqual({
      ok: true,
      value: {
        state: {
          providerId: "claude-code",
          enabled: true,
          disabledBy: null,
          selected: { kind: "bundled" },
          candidates: [],
          authPending: false,
          checkedAt: null,
          apiKey: { supported: false, configured: false, source: null },
          terminalAgentArgs: "",
          envOverrides: [],
          loginCapability: null,
          auth: {
            status: "unknown",
            badgeText: null,
            label: null,
            detail: null,
          },
        },
      },
    });
  });

  it("registers each stated-item version as its method's latest", () => {
    const shellGet = hostRpcRegistry["config.shell.get"][1];
    expect(shellGet.latestMinor).toEqual(1);
    expect(shellGet.versions[1].contract).toBe(configShellGetV11);

    const shellSet = hostRpcRegistry["config.shell.set"][1];
    expect(shellSet.latestMinor).toEqual(2);
    expect(shellSet.versions[2].contract).toBe(configShellSetV12);
    expect(shellSet.versions[2].upgradeFromPreviousVersion).toBe(
      configShellSetUpgradeV11ToV12,
    );

    const shellAdd = hostRpcRegistry["config.shell.add"][1];
    expect(shellAdd.latestMinor).toEqual(2);
    expect(shellAdd.versions[2].contract).toBe(configShellAddV12);

    const shellRemove = hostRpcRegistry["config.shell.remove"][1];
    expect(shellRemove.latestMinor).toEqual(2);
    expect(shellRemove.versions[2].contract).toBe(configShellRemoveV12);

    const shellRevert = hostRpcRegistry["config.shell.revertArgs"][1];
    expect(shellRevert.latestMinor).toEqual(2);
    expect(shellRevert.versions[2].contract).toBe(configShellRevertArgsV12);

    const usePack = hostRpcRegistry["providers.usePackVersion"][1];
    expect(usePack.latestMinor).toEqual(2);
    expect(usePack.versions[2].contract).toBe(providersUsePackVersionV12);

    const setPolicy = hostRpcRegistry["providers.setPackPolicy"][1];
    expect(setPolicy.latestMinor).toEqual(1);
    expect(setPolicy.versions[1].contract).toBe(providersSetPackPolicyV11);

    const setEnabled = hostRpcRegistry["providers.setEnabled"][2];
    expect(setEnabled.latestMinor).toEqual(2);
    expect(setEnabled.versions[2].contract).toBe(providersSetEnabledV22);
    expect(setEnabled.downgradePathsFromLatest[1]).toBe(
      providersSetEnabledDowngradeV22ToV10,
    );

    const proposals = hostRpcRegistry["environment.proposals"];
    expect(proposals.degrade).toEqual({ kind: "unsupported" });
    expect(proposals[1].latestMinor).toEqual(0);
    expect(proposals[1].versions[0].contract).toBe(environmentProposalsV10);
  });

  it("upgrades a 1.0 shell set to the registered 1.2 with no selection stated", () => {
    expect(
      upgradeRequestToVersion(
        hostRpcRegistry["config.shell.set"],
        { major: 1, minor: 0 },
        { major: 1, minor: 2 },
        { path: "/bin/zsh", args: ["-l"] },
      ),
    ).toEqual({
      path: "/bin/zsh",
      args: ["-l"],
      executableWriteGrant: null,
      selection: { kind: "not_stated" },
    });
  });

  it("parses the account settings refresh, which the registry cannot reach yet", () => {
    expect(hostAccountSettingsRefreshV10.method).toEqual(
      "host.accountSettings.refresh",
    );
    expect(hostAccountSettingsRefreshV10.requestSchema.parse({})).toEqual({});
    expect(hostAccountSettingsRefreshV10.responseSchema.parse({})).toEqual({});
    expect("host.accountSettings.refresh" in hostRpcRegistry).toBe(false);
  });
});

describe("readSettingsProposalRefusalReason", () => {
  it("reads too_large as too_large", () => {
    expect(readSettingsProposalRefusalReason("too_large")).toEqual("too_large");
  });

  it("reads an unknown reason as unrecognised", () => {
    expect(readSettingsProposalRefusalReason("later_reason")).toEqual(
      "unrecognised",
    );
  });
});
