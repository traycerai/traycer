import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  defineDowngradePath,
  defineRpcContract,
  defineUpgradePath,
  downgradeRequestAcrossMajors,
  downgradeResponseAcrossMajors,
  getLatestContract,
  upgradeRequestToVersion,
  upgradeResponseToVersion,
  validateVersionedRpcRegistry,
  type UncheckedVersionedRpcRegistry,
  type VersionedRpcRegistry,
} from "@traycer/protocol/framework/index";

const echoV10 = defineRpcContract({
  method: "echo",
  schemaVersion: {
    major: 1,
    minor: 0,
  } as const,
  requestSchema: z.object({
    text: z.string(),
  }),
  responseSchema: z.object({
    upper: z.string(),
  }),
});

const echoV11 = defineRpcContract({
  method: "echo",
  schemaVersion: {
    major: 1,
    minor: 1,
  } as const,
  requestSchema: z.object({
    text: z.string(),
    trim: z.boolean(),
  }),
  responseSchema: z.object({
    upper: z.string(),
    trimmed: z.boolean(),
  }),
});

const echoV21 = defineRpcContract({
  method: "echo",
  schemaVersion: {
    major: 2,
    minor: 1,
  } as const,
  requestSchema: z.object({
    // Tightened vs echoV11 so the 1 -> 2 bump is a real breaking change.
    text: z.string().min(1),
    trim: z.boolean(),
    locale: z.string().nullable(),
  }),
  responseSchema: z.object({
    upper: z.string(),
    trimmed: z.boolean(),
    localeApplied: z.boolean(),
  }),
});

const echoV23 = defineRpcContract({
  method: "echo",
  schemaVersion: {
    major: 2,
    minor: 3,
  } as const,
  requestSchema: z.object({
    text: z.string().min(1),
    trim: z.boolean(),
    locale: z.string().nullable(),
    emphasis: z.boolean(),
  }),
  responseSchema: z.object({
    upper: z.string(),
    trimmed: z.boolean(),
    localeApplied: z.boolean(),
    decorated: z.boolean(),
  }),
});

const echoV30 = defineRpcContract({
  method: "echo",
  schemaVersion: {
    major: 3,
    minor: 0,
  } as const,
  requestSchema: z.object({
    text: z.string(),
    trim: z.boolean(),
    locale: z.string(),
    emphasis: z.boolean(),
  }),
  responseSchema: z.object({
    upper: z.string(),
    trimmed: z.boolean(),
    localeApplied: z.boolean(),
    decorated: z.boolean(),
    format: z.union([z.literal("plain"), z.literal("rich")]),
  }),
});

const upgradeV10ToV11 = defineUpgradePath<typeof echoV10, typeof echoV11>({
  from: echoV10.schemaVersion,
  to: echoV11.schemaVersion,
  upgradeRequest: (request) => ({
    text: request.text,
    trim: false,
  }),
  upgradeResponse: (response) => ({
    upper: response.upper,
    trimmed: false,
  }),
});

const upgradeV11ToV21 = defineUpgradePath<typeof echoV11, typeof echoV21>({
  from: echoV11.schemaVersion,
  to: echoV21.schemaVersion,
  upgradeRequest: (request) => ({
    text: request.text,
    trim: request.trim,
    locale: null,
  }),
  upgradeResponse: (response) => ({
    upper: response.upper,
    trimmed: response.trimmed,
    localeApplied: false,
  }),
});

const upgradeV21ToV23 = defineUpgradePath<typeof echoV21, typeof echoV23>({
  from: echoV21.schemaVersion,
  to: echoV23.schemaVersion,
  upgradeRequest: (request) => ({
    text: request.text,
    trim: request.trim,
    locale: request.locale,
    emphasis: false,
  }),
  upgradeResponse: (response) => ({
    upper: response.upper,
    trimmed: response.trimmed,
    localeApplied: response.localeApplied,
    decorated: false,
  }),
});

const upgradeV23ToV30 = defineUpgradePath<typeof echoV23, typeof echoV30>({
  from: echoV23.schemaVersion,
  to: echoV30.schemaVersion,
  upgradeRequest: (request) => ({
    text: request.text,
    trim: request.trim,
    locale: request.locale ?? "en",
    emphasis: request.emphasis,
  }),
  upgradeResponse: (response) => ({
    upper: response.upper,
    trimmed: response.trimmed,
    localeApplied: response.localeApplied,
    decorated: response.decorated,
    format: "plain",
  }),
});

const downgradeV23ToV11 = defineDowngradePath<typeof echoV23, typeof echoV11>({
  from: echoV23.schemaVersion,
  to: echoV11.schemaVersion,
  downgradeRequest: (request) => ({
    ok: true,
    value: {
      text: request.text,
      trim: request.trim,
    },
  }),
  downgradeResponse: (response) => ({
    ok: true,
    value: {
      upper: response.upper,
      trimmed: response.trimmed,
    },
  }),
});

const downgradeV30ToV23 = defineDowngradePath<typeof echoV30, typeof echoV23>({
  from: echoV30.schemaVersion,
  to: echoV23.schemaVersion,
  downgradeRequest: (request) => ({
    ok: true,
    value: {
      text: request.text,
      trim: request.trim,
      locale: request.locale,
      emphasis: request.emphasis,
    },
  }),
  downgradeResponse: (response) => ({
    ok: true,
    value: {
      upper: response.upper,
      trimmed: response.trimmed,
      localeApplied: response.localeApplied,
      decorated: response.decorated,
    },
  }),
});

const downgradeV30ToV11 = defineDowngradePath<typeof echoV30, typeof echoV11>({
  from: echoV30.schemaVersion,
  to: echoV11.schemaVersion,
  downgradeRequest: (request) => ({
    ok: true,
    value: {
      text: request.text,
      trim: request.trim,
    },
  }),
  downgradeResponse: (response) => ({
    ok: true,
    value: {
      upper: response.upper,
      trimmed: response.trimmed,
    },
  }),
});

const echoV31 = defineRpcContract({
  method: "echo",
  schemaVersion: {
    major: 3,
    minor: 1,
  } as const,
  requestSchema: z.object({
    text: z.string(),
  }),
  responseSchema: z.object({
    upper: z.string(),
  }),
});

function makeRegistry() {
  const registry = {
    echo: {
      1: {
        latestMinor: 1,
        versions: {
          0: {
            contract: echoV10,
            upgradeFromPreviousVersion: null,
          },
          1: {
            contract: echoV11,
            upgradeFromPreviousVersion: upgradeV10ToV11,
          },
        },
        downgradePathsFromLatest: {},
      },
      2: {
        latestMinor: 3,
        versions: {
          1: {
            contract: echoV21,
            upgradeFromPreviousVersion: upgradeV11ToV21,
          },
          3: {
            contract: echoV23,
            upgradeFromPreviousVersion: upgradeV21ToV23,
          },
        },
        downgradePathsFromLatest: {
          1: downgradeV23ToV11,
        },
      },
      3: {
        latestMinor: 0,
        versions: {
          0: {
            contract: echoV30,
            upgradeFromPreviousVersion: upgradeV23ToV30,
          },
        },
        downgradePathsFromLatest: {
          2: downgradeV30ToV23,
          1: downgradeV30ToV11,
        },
      },
    },
  } as const;

  validateVersionedRpcRegistry(registry);
  const validatedRegistry: VersionedRpcRegistry<typeof registry> = registry;
  return validatedRegistry;
}

describe("Versioned RPC registry", () => {
  it("returns the latest contract overall and for a specific major line", () => {
    const registry = makeRegistry();

    expect(getLatestContract(registry.echo, undefined)).toBe(echoV30);
    expect(getLatestContract(registry.echo, 2)).toBe(echoV23);
  });

  it("composes request upgrades through the installed version chain", () => {
    const registry = makeRegistry();

    const upgraded = upgradeRequestToVersion(
      registry.echo,
      {
        major: 1,
        minor: 0,
      },
      {
        major: 3,
        minor: 0,
      },
      {
        text: "hello",
      },
    );

    expect(upgraded).toEqual({
      text: "hello",
      trim: false,
      locale: "en",
      emphasis: false,
    });
  });

  it("composes response upgrades through same-major and cross-major version steps", () => {
    const registry = makeRegistry();

    const upgraded = upgradeResponseToVersion(
      registry.echo,
      {
        major: 1,
        minor: 0,
      },
      {
        major: 2,
        minor: 3,
      },
      {
        upper: "HELLO",
      },
    );

    expect(upgraded).toEqual({
      upper: "HELLO",
      trimmed: false,
      localeApplied: false,
      decorated: false,
    });
  });

  it("uses direct request downgrades from the latest minor of the source major", () => {
    const registry = {
      echo: {
        1: {
          latestMinor: 1,
          versions: {
            0: {
              contract: echoV10,
              upgradeFromPreviousVersion: null,
            },
            1: {
              contract: echoV11,
              upgradeFromPreviousVersion: upgradeV10ToV11,
            },
          },
          downgradePathsFromLatest: {},
        },
        2: {
          latestMinor: 3,
          versions: {
            1: {
              contract: echoV21,
              upgradeFromPreviousVersion: upgradeV11ToV21,
            },
            3: {
              contract: echoV23,
              upgradeFromPreviousVersion: upgradeV21ToV23,
            },
          },
          downgradePathsFromLatest: {
            1: downgradeV23ToV11,
          },
        },
        3: {
          latestMinor: 0,
          versions: {
            0: {
              contract: echoV30,
              upgradeFromPreviousVersion: upgradeV23ToV30,
            },
          },
          downgradePathsFromLatest: {
            2: downgradeV30ToV23,
          },
        },
      },
    } as const;

    validateVersionedRpcRegistry(registry);
    const validatedRegistry: VersionedRpcRegistry<typeof registry> = registry;

    expect(
      downgradeRequestAcrossMajors(validatedRegistry.echo, 3, 1, {
        text: "hello",
        trim: false,
        locale: "en",
        emphasis: false,
      }),
    ).toEqual({
      ok: false,
      error: {
        code: "DOWNGRADE_UNSUPPORTED",
        message: "No direct downgrade path exists from major 3 to major 1",
      },
    });
  });

  it("uses direct response downgrades from the latest minor when the path exists", () => {
    const registry = makeRegistry();

    expect(
      downgradeResponseAcrossMajors(registry.echo, 3, 1, {
        upper: "HELLO",
        trimmed: true,
        localeApplied: true,
        decorated: true,
        format: "rich",
      }),
    ).toEqual({
      ok: true,
      value: {
        upper: "HELLO",
        trimmed: true,
      },
    });
  });

  it("rejects method mismatches inside a method registry", () => {
    const otherV11 = defineRpcContract({
      method: "other",
      schemaVersion: {
        major: 1,
        minor: 1,
      } as const,
      requestSchema: z.object({
        text: z.string(),
        trim: z.boolean(),
      }),
      responseSchema: z.object({
        upper: z.string(),
        trimmed: z.boolean(),
      }),
    });

    const invalidRegistry: UncheckedVersionedRpcRegistry = {
      echo: {
        1: {
          latestMinor: 1,
          versions: {
            1: {
              contract: otherV11,
              upgradeFromPreviousVersion: null,
            },
          },
          downgradePathsFromLatest: {},
        },
      },
    };

    expect(() => validateVersionedRpcRegistry(invalidRegistry)).toThrow(
      "Contract method 'other' does not match registry method 'echo'",
    );
  });

  it("rejects latestMinor values that are not defined in the major line", () => {
    const invalidRegistry: UncheckedVersionedRpcRegistry = {
      echo: {
        1: {
          latestMinor: 2,
          versions: {
            0: {
              contract: echoV10,
              upgradeFromPreviousVersion: null,
            },
            1: {
              contract: echoV11,
              upgradeFromPreviousVersion: upgradeV10ToV11,
            },
          },
          downgradePathsFromLatest: {},
        },
      },
    };

    expect(() => validateVersionedRpcRegistry(invalidRegistry)).toThrow(
      "Latest minor 2 is not defined for method 'echo' major 1",
    );
  });

  it("rejects major lines whose latestMinor is not the highest installed version", () => {
    const invalidRegistry: UncheckedVersionedRpcRegistry = {
      echo: {
        2: {
          latestMinor: 1,
          versions: {
            1: {
              contract: echoV21,
              upgradeFromPreviousVersion: null,
            },
            3: {
              contract: echoV23,
              upgradeFromPreviousVersion: upgradeV21ToV23,
            },
          },
          downgradePathsFromLatest: {},
        },
      },
    };

    expect(() => validateVersionedRpcRegistry(invalidRegistry)).toThrow(
      "Latest minor 1 for method 'echo' major 2 must be the highest installed minor 3",
    );
  });

  it("rejects missing version-to-version upgrades after the first installed version", () => {
    const invalidRegistry: UncheckedVersionedRpcRegistry = {
      echo: {
        1: {
          latestMinor: 1,
          versions: {
            0: {
              contract: echoV10,
              upgradeFromPreviousVersion: null,
            },
            1: {
              contract: echoV11,
              upgradeFromPreviousVersion: null,
            },
          },
          downgradePathsFromLatest: {},
        },
      },
    };

    expect(() => validateVersionedRpcRegistry(invalidRegistry)).toThrow(
      "Version 1.1 for method 'echo' must define an upgrade path from version 1.0",
    );
  });

  it("rejects upgrades that do not connect the previous installed version", () => {
    const invalidRegistry: UncheckedVersionedRpcRegistry = {
      echo: {
        1: {
          latestMinor: 1,
          versions: {
            0: {
              contract: echoV10,
              upgradeFromPreviousVersion: null,
            },
            1: {
              contract: echoV11,
              upgradeFromPreviousVersion: upgradeV10ToV11,
            },
          },
          downgradePathsFromLatest: {},
        },
        2: {
          latestMinor: 1,
          versions: {
            1: {
              contract: echoV21,
              upgradeFromPreviousVersion: defineUpgradePath<
                typeof echoV10,
                typeof echoV21
              >({
                from: echoV10.schemaVersion,
                to: echoV21.schemaVersion,
                upgradeRequest: (request) => ({
                  text: request.text,
                  trim: false,
                  locale: null,
                }),
                upgradeResponse: (response) => ({
                  upper: response.upper,
                  trimmed: false,
                  localeApplied: false,
                }),
              }),
            },
          },
          downgradePathsFromLatest: {},
        },
      },
    };

    expect(() => validateVersionedRpcRegistry(invalidRegistry)).toThrow(
      "Upgrade path for method 'echo' version 2.1 must start at previous installed version 1.1",
    );
  });

  it("rejects downgrade paths that do not originate at the latest minor of the line", () => {
    const invalidRegistry: UncheckedVersionedRpcRegistry = {
      echo: {
        1: {
          latestMinor: 1,
          versions: {
            0: {
              contract: echoV10,
              upgradeFromPreviousVersion: null,
            },
            1: {
              contract: echoV11,
              upgradeFromPreviousVersion: upgradeV10ToV11,
            },
          },
          downgradePathsFromLatest: {},
        },
        2: {
          latestMinor: 3,
          versions: {
            1: {
              contract: echoV21,
              upgradeFromPreviousVersion: upgradeV11ToV21,
            },
            3: {
              contract: echoV23,
              upgradeFromPreviousVersion: upgradeV21ToV23,
            },
          },
          downgradePathsFromLatest: {
            1: defineDowngradePath<typeof echoV21, typeof echoV11>({
              from: echoV21.schemaVersion,
              to: echoV11.schemaVersion,
              downgradeRequest: (request) => ({
                ok: true,
                value: {
                  text: request.text,
                  trim: request.trim,
                },
              }),
              downgradeResponse: (response) => ({
                ok: true,
                value: {
                  upper: response.upper,
                  trimmed: response.trimmed,
                },
              }),
            }),
          },
        },
      },
    };

    expect(() => validateVersionedRpcRegistry(invalidRegistry)).toThrow(
      "Downgrade path for method 'echo' major 2 to major 1 must start at latest minor 3 of major 2",
    );
  });
});
