import { describe, expectTypeOf, it } from "vitest";
import { z } from "zod";
import {
  defineDowngradePath,
  defineFallbackMethodDegrade,
  defineFloorAwareVersionedRpcRegistry,
  defineRpcContract,
  defineUpgradePath,
  defineVersionedRpcRegistry,
  getLatestContract,
  validateVersionedRpcRegistry,
  type DowngradeResult,
  type LatestContract,
  type RequestOf,
  type ResponseOf,
  type RpcErrorFor,
  type RpcRequestFor,
  type RpcSuccessFor,
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

function makeUncheckedRegistry(): UncheckedVersionedRpcRegistry {
  return {
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
            upgradeFromPreviousVersion: upgradeV11ToV21,
          },
        },
        downgradePathsFromLatest: {},
      },
    },
  };
}

describe("Versioned RPC typing", () => {
  it("pairs request envelopes to the contract request type", () => {
    type EchoRequest = RpcRequestFor<typeof echoV21>;

    expectTypeOf<EchoRequest["method"]>().toEqualTypeOf<"echo">();
    expectTypeOf<EchoRequest["schemaVersion"]>().toEqualTypeOf<{
      readonly major: 2;
      readonly minor: 1;
    }>();
    expectTypeOf<EchoRequest["params"]>().branded.toEqualTypeOf<{
      text: string;
      trim: boolean;
      locale: string | null;
    }>();
  });

  it("pairs success envelopes to the contract response type", () => {
    type EchoSuccess = RpcSuccessFor<typeof echoV30>;

    expectTypeOf<EchoSuccess["result"]>().branded.toEqualTypeOf<{
      upper: string;
      trimmed: boolean;
      localeApplied: boolean;
      decorated: boolean;
      format: "plain" | "rich";
    }>();
  });

  it("pairs error envelopes to the contract identity", () => {
    type EchoError = RpcErrorFor<typeof echoV11>;

    expectTypeOf<EchoError["method"]>().toEqualTypeOf<"echo">();
    expectTypeOf<EchoError["schemaVersion"]>().toEqualTypeOf<{
      readonly major: 1;
      readonly minor: 1;
    }>();
  });

  it("keeps upgrade paths strongly typed between sequential version payloads", () => {
    const upgradePath = defineUpgradePath<typeof echoV11, typeof echoV21>({
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

    expectTypeOf<Parameters<typeof upgradePath.upgradeRequest>>().toEqualTypeOf<
      [RequestOf<typeof echoV11>]
    >();
    expectTypeOf(upgradePath.upgradeRequest).returns.toEqualTypeOf<
      RequestOf<typeof echoV21>
    >();
    expectTypeOf<
      Parameters<typeof upgradePath.upgradeResponse>
    >().toEqualTypeOf<[ResponseOf<typeof echoV11>]>();
    expectTypeOf(upgradePath.upgradeResponse).returns.toEqualTypeOf<
      ResponseOf<typeof echoV21>
    >();
  });

  it("keeps downgrade paths strongly typed from a major line's latest contract", () => {
    const downgradePath = defineDowngradePath<typeof echoV30, typeof echoV11>({
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

    expectTypeOf<
      Parameters<typeof downgradePath.downgradeRequest>
    >().toEqualTypeOf<[RequestOf<typeof echoV30>]>();
    expectTypeOf(downgradePath.downgradeRequest).returns.toEqualTypeOf<
      DowngradeResult<RequestOf<typeof echoV11>>
    >();
    expectTypeOf<
      Parameters<typeof downgradePath.downgradeResponse>
    >().toEqualTypeOf<[ResponseOf<typeof echoV30>]>();
    expectTypeOf(downgradePath.downgradeResponse).returns.toEqualTypeOf<
      DowngradeResult<ResponseOf<typeof echoV11>>
    >();
  });

  it("derives the latest contract type from the highest installed version", () => {
    const validatedRegistry = defineVersionedRpcRegistry({
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
              upgradeFromPreviousVersion: defineUpgradePath<
                typeof echoV21,
                typeof echoV23
              >({
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
              }),
            },
          },
          downgradePathsFromLatest: {},
        },
      },
    });

    type EchoLatest = LatestContract<typeof validatedRegistry.echo>;

    expectTypeOf<EchoLatest>().toEqualTypeOf<typeof echoV23>();
    expectTypeOf(
      getLatestContract(validatedRegistry.echo, undefined),
    ).toEqualTypeOf<typeof echoV23>();
  });

  it("rejects registry contracts whose method does not match the method key", () => {
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

    const assertCompileTime = (): void => {
      defineVersionedRpcRegistry({
        echo: {
          1: {
            latestMinor: 1,
            versions: {
              0: {
                contract: echoV10,
                upgradeFromPreviousVersion: null,
              },
              1: {
                // @ts-expect-error Registry method keys must match every contract they contain.
                contract: otherV11,
                // @ts-expect-error The entry type collapses once the contract method mismatches.
                upgradeFromPreviousVersion: upgradeV10ToV11,
              },
            },
            downgradePathsFromLatest: {},
          },
        },
      });
    };

    expectTypeOf(assertCompileTime).toBeFunction();
  });

  it("rejects latestMinor values that are not the highest defined version", () => {
    const assertCompileTime = (): void => {
      defineVersionedRpcRegistry({
        echo: {
          1: {
            // @ts-expect-error latestMinor must point at the highest installed version.
            latestMinor: 0,
            // @ts-expect-error The line collapses once latestMinor no longer matches the highest installed version.
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
            // @ts-expect-error The line collapses once latestMinor no longer matches the highest installed version.
            downgradePathsFromLatest: {},
          },
        },
      });
    };

    expectTypeOf(assertCompileTime).toBeFunction();
  });

  it("rejects version upgrades that are typed against a different previous installed contract", () => {
    const echoV11Variant = defineRpcContract({
      method: "echo",
      schemaVersion: {
        major: 1,
        minor: 1,
      } as const,
      requestSchema: z.object({
        count: z.number(),
        trim: z.boolean(),
      }),
      responseSchema: z.object({
        total: z.number(),
        trimmed: z.boolean(),
      }),
    });

    const upgradeFromVariantToV21 = defineUpgradePath<
      typeof echoV11Variant,
      typeof echoV21
    >({
      from: echoV11Variant.schemaVersion,
      to: echoV21.schemaVersion,
      upgradeRequest: (request) => ({
        text: String(request.count),
        trim: request.trim,
        locale: null,
      }),
      upgradeResponse: (response) => ({
        upper: String(response.total),
        trimmed: response.trimmed,
        localeApplied: false,
      }),
    });

    const assertCompileTime = (): void => {
      defineVersionedRpcRegistry({
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
                // @ts-expect-error Upgrade paths must start from the previous installed version in the chain.
                upgradeFromPreviousVersion: upgradeFromVariantToV21,
              },
            },
            downgradePathsFromLatest: {},
          },
        },
      });
    };

    expectTypeOf(assertCompileTime).toBeFunction();
  });

  it("rejects downgrade paths that are not typed from a line's latest contract", () => {
    const downgradeFromV21ToV11 = defineDowngradePath<
      typeof echoV21,
      typeof echoV11
    >({
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
    });

    const assertCompileTime = (): void => {
      defineVersionedRpcRegistry({
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
                upgradeFromPreviousVersion: defineUpgradePath<
                  typeof echoV21,
                  typeof echoV23
                >({
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
                }),
              },
            },
            downgradePathsFromLatest: {
              // @ts-expect-error Downgrade paths on a major line must originate from that line's latest contract.
              1: downgradeFromV21ToV11,
            },
          },
        },
      });
    };

    expectTypeOf(assertCompileTime).toBeFunction();
  });

  it("rejects traversal helpers when the registry has not been validated", () => {
    const uncheckedRegistry = makeUncheckedRegistry();

    const assertCompileTime = (): void => {
      // @ts-expect-error Traversal helpers require validated method registries.
      getLatestContract(uncheckedRegistry.echo, undefined);
    };

    expectTypeOf(assertCompileTime).toBeFunction();
  });

  it("narrows unchecked registries after runtime validation", () => {
    const assertCompileTime = (): void => {
      const uncheckedRegistry = {
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
                upgradeFromPreviousVersion: upgradeV11ToV21,
              },
            },
            downgradePathsFromLatest: {},
          },
        },
      } satisfies UncheckedVersionedRpcRegistry;

      validateVersionedRpcRegistry(uncheckedRegistry);
      const validatedRegistry: VersionedRpcRegistry<typeof uncheckedRegistry> =
        uncheckedRegistry;

      getLatestContract(validatedRegistry.echo, undefined);
    };

    expectTypeOf(assertCompileTime).toBeFunction();
  });

  it("requires degrade declarations for non-floor methods", () => {
    const assertCompileTime = (): void => {
      defineFloorAwareVersionedRpcRegistry(["echo"] as const, {
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
        },
        // @ts-expect-error Non-floor methods must declare a degrade strategy.
        extra: {
          1: {
            latestMinor: 0,
            versions: {
              0: {
                contract: defineRpcContract({
                  method: "extra",
                  schemaVersion: { major: 1, minor: 0 } as const,
                  requestSchema: z.object({ text: z.string() }),
                  responseSchema: z.object({ upper: z.string() }),
                }),
                upgradeFromPreviousVersion: null,
              },
            },
            downgradePathsFromLatest: {},
          },
        },
      });
    };

    expectTypeOf(assertCompileTime).toBeFunction();
  });

  it("types fallback degrade adapters and floor targets", () => {
    const fallback = defineFallbackMethodDegrade<
      typeof echoV21,
      typeof echoV11,
      "echo"
    >({
      kind: "fallback",
      to: { method: "echo", major: 1, minor: 1 },
      adaptRequest: (request) => ({
        text: request.text,
        trim: request.trim,
      }),
      adaptResponse: (response) => ({
        upper: response.upper,
        trimmed: response.trimmed,
        localeApplied: false,
      }),
    });

    expectTypeOf<Parameters<typeof fallback.adaptRequest>>().toEqualTypeOf<
      [RequestOf<typeof echoV21>]
    >();
    expectTypeOf(fallback.adaptRequest).returns.toEqualTypeOf<
      RequestOf<typeof echoV11>
    >();
    expectTypeOf<Parameters<typeof fallback.adaptResponse>>().toEqualTypeOf<
      [ResponseOf<typeof echoV11>]
    >();
    expectTypeOf(fallback.adaptResponse).returns.toEqualTypeOf<
      ResponseOf<typeof echoV21>
    >();

    const assertCompileTime = (): void => {
      defineFallbackMethodDegrade<typeof echoV21, typeof echoV11, "echo">({
        kind: "fallback",
        to: {
          // @ts-expect-error Fallback targets are constrained to floor methods.
          method: "extra",
          major: 1,
          minor: 1,
        },
        adaptRequest: (request) => ({
          text: request.text,
          trim: request.trim,
        }),
        adaptResponse: (response) => ({
          upper: response.upper,
          trimmed: response.trimmed,
          localeApplied: false,
        }),
      });
    };

    expectTypeOf(assertCompileTime).toBeFunction();
  });
});
