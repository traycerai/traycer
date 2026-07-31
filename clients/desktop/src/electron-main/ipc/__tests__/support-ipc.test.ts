import { describe, expect, it } from "vitest";
import {
  MAX_REPORT_IMAGE_BYTES,
  MAX_REPORT_IMAGES,
  REPORT_LOG_TAIL_MAX_BYTES,
  TOTAL_ATTACHMENT_BUDGET_BYTES,
} from "@traycer-clients/shared/support/image-attachment-guards";
import {
  parseSupportFreezeEvidenceInput,
  parseSupportReadFrozenLogTailInput,
  parseSupportSubmitReportRequest,
  parseSupportTailLogInput,
} from "../support-ipc";

const VALID_FORM = {
  draftId: 1,
  type: "bug",
  intent: "It broke",
  frequency: "sometimes",
  location: null,
  allowContact: false,
  includeDesktopLog: true,
  includeHostLog: true,
  includeDiagnostics: true,
  images: [],
  overrideTitle: null,
  privateOutcome: "delivered",
};

describe("parseSupportTailLogInput", () => {
  it("accepts and clamps a valid request", () => {
    expect(
      parseSupportTailLogInput({ target: "host", tailLines: 1_000 }),
    ).toEqual({ target: "host", tailLines: 500 });
  });

  it.each([null, "desktop", [], 42])(
    "rejects a malformed request payload",
    (input) => {
      expect(() => parseSupportTailLogInput(input)).toThrow();
    },
  );
});

/** Small valid PNG magic + padding. */
function pngArrayBuffer(length: number): ArrayBuffer {
  const bytes = new Uint8Array(length);
  bytes[0] = 0x89;
  bytes[1] = 0x50;
  bytes[2] = 0x4e;
  bytes[3] = 0x47;
  return bytes.buffer;
}

function jpegArrayBuffer(length: number): ArrayBuffer {
  const bytes = new Uint8Array(length);
  bytes[0] = 0xff;
  bytes[1] = 0xd8;
  bytes[2] = 0xff;
  return bytes.buffer;
}

function gifArrayBuffer(length: number): ArrayBuffer {
  const bytes = new Uint8Array(length);
  bytes[0] = 0x47;
  bytes[1] = 0x49;
  bytes[2] = 0x46;
  bytes[3] = 0x38;
  return bytes.buffer;
}

function webpArrayBuffer(length: number): ArrayBuffer {
  const bytes = new Uint8Array(Math.max(length, 12));
  bytes[0] = 0x52;
  bytes[1] = 0x49;
  bytes[2] = 0x46;
  bytes[3] = 0x46;
  bytes[8] = 0x57;
  bytes[9] = 0x45;
  bytes[10] = 0x42;
  bytes[11] = 0x50;
  return bytes.buffer;
}

const SMALL_PNG = (): ArrayBuffer => pngArrayBuffer(32);
const SMALL_JPEG = (): ArrayBuffer => jpegArrayBuffer(32);
const SMALL_GIF = (): ArrayBuffer => gifArrayBuffer(32);
const SMALL_WEBP = (): ArrayBuffer => webpArrayBuffer(32);

function imageAttachment(overrides: {
  readonly fileName: string | undefined;
  readonly mimeType: string | undefined;
  readonly bytes: ArrayBuffer | undefined;
}) {
  return {
    fileName: overrides.fileName ?? "shot.png",
    mimeType: overrides.mimeType ?? "image/png",
    bytes: overrides.bytes ?? SMALL_PNG(),
  };
}

function defaultImageAttachment() {
  return imageAttachment({
    fileName: undefined,
    mimeType: undefined,
    bytes: undefined,
  });
}

const VALID_CAUSE = {
  type: "RangeError",
  message: "index out of bounds",
  stack: "at foo (bar.ts:1:1)",
  componentStack: null,
  errorCode: "E_BOUNDS",
  sourceAction: "chat.subscribe",
  timestamp: 1_700_000_000_000,
};

const KNOWN_STRING = { status: "known", value: "epic-1" };
const STALE_STRING = { status: "stale", value: "tab-1" };
const UNAVAILABLE = { status: "unavailable" };

// Field-for-field match with ticket 05's `SupportContextSnapshot`
// (clients/gui-app/src/lib/support-context-registry.ts).
const VALID_REGISTRY = {
  routeTemplate: KNOWN_STRING,
  hostId: KNOWN_STRING,
  epicId: KNOWN_STRING,
  tabId: STALE_STRING,
  artifactId: UNAVAILABLE,
  chatId: KNOWN_STRING,
  agentId: KNOWN_STRING,
  harnessId: KNOWN_STRING,
  model: KNOWN_STRING,
  profileId: { status: "known", value: null },
  providerSelectionClass: { status: "known", value: "bundled" },
  providerVersion: { status: "stale", value: null },
};

const VALID_PRIVATE_DIAGNOSTICS = {
  cause: VALID_CAUSE,
  registry: VALID_REGISTRY,
  fingerprint: "fp:v1:abc",
  stackFamily: "stack:v1:abc",
  correlationId: "corr-1",
};

describe("parseSupportSubmitReportRequest", () => {
  it("accepts a well-formed request with no privateDiagnostics", () => {
    expect(parseSupportSubmitReportRequest(VALID_FORM)).toEqual(VALID_FORM);
  });

  it("rejects a non-object payload", () => {
    expect(() => parseSupportSubmitReportRequest(null)).toThrow();
    expect(() => parseSupportSubmitReportRequest("nope")).toThrow();
    expect(() => parseSupportSubmitReportRequest([VALID_FORM])).toThrow();
  });

  it("rejects a missing draftId", () => {
    const { draftId: _draftId, ...withoutDraftId } = VALID_FORM;
    expect(() => parseSupportSubmitReportRequest(withoutDraftId)).toThrow();
  });

  it("rejects a non-number draftId", () => {
    expect(() =>
      parseSupportSubmitReportRequest({ ...VALID_FORM, draftId: "1" }),
    ).toThrow();
  });

  it("rejects a non-string intent", () => {
    expect(() =>
      parseSupportSubmitReportRequest({ ...VALID_FORM, intent: 42 }),
    ).toThrow();
  });

  it("rejects a type outside bug/idea/other", () => {
    expect(() =>
      parseSupportSubmitReportRequest({ ...VALID_FORM, type: "wish" }),
    ).toThrow();
  });

  it.each(["bug", "idea", "other"])("accepts type %s", (type) => {
    const result = parseSupportSubmitReportRequest({ ...VALID_FORM, type });
    expect(result.type).toBe(type);
  });

  it.each(["once", "sometimes", "every_time", "not_sure"])(
    "accepts frequency %s",
    (frequency) => {
      const result = parseSupportSubmitReportRequest({
        ...VALID_FORM,
        frequency,
      });
      expect(result.frequency).toBe(frequency);
    },
  );

  it("accepts a null frequency - the unselected/hidden default", () => {
    const result = parseSupportSubmitReportRequest({
      ...VALID_FORM,
      frequency: null,
    });
    expect(result.frequency).toBeNull();
  });

  it("rejects a frequency outside the known set", () => {
    expect(() =>
      parseSupportSubmitReportRequest({ ...VALID_FORM, frequency: "daily" }),
    ).toThrow();
  });

  it("rejects a missing frequency key - the wire always carries it", () => {
    const { frequency: _frequency, ...withoutFrequency } = VALID_FORM;
    expect(() => parseSupportSubmitReportRequest(withoutFrequency)).toThrow();
  });

  it("accepts a non-null location - the actively-changed selector value (D7)", () => {
    const result = parseSupportSubmitReportRequest({
      ...VALID_FORM,
      location: "Terminal",
    });
    expect(result.location).toBe("Terminal");
  });

  it("rejects a missing location key - the wire always carries it", () => {
    const { location: _location, ...withoutLocation } = VALID_FORM;
    expect(() => parseSupportSubmitReportRequest(withoutLocation)).toThrow();
  });

  it("rejects a non-string non-null location", () => {
    expect(() =>
      parseSupportSubmitReportRequest({ ...VALID_FORM, location: 42 }),
    ).toThrow();
  });

  it.each([true, false])("accepts allowContact %s", (allowContact) => {
    const result = parseSupportSubmitReportRequest({
      ...VALID_FORM,
      allowContact,
    });
    expect(result.allowContact).toBe(allowContact);
  });

  it("rejects a non-boolean allowContact", () => {
    expect(() =>
      parseSupportSubmitReportRequest({ ...VALID_FORM, allowContact: "yes" }),
    ).toThrow();
  });

  it.each(["includeDesktopLog", "includeHostLog"] as const)(
    "rejects a missing %s key",
    (key) => {
      const withoutKey = { ...VALID_FORM };
      delete (withoutKey as Record<string, unknown>)[key];
      expect(() => parseSupportSubmitReportRequest(withoutKey)).toThrow();
    },
  );

  it.each(["includeDesktopLog", "includeHostLog"] as const)(
    "rejects a non-boolean %s",
    (key) => {
      expect(() =>
        parseSupportSubmitReportRequest({ ...VALID_FORM, [key]: "on" }),
      ).toThrow();
    },
  );

  it("accepts independently toggled log flags", () => {
    const result = parseSupportSubmitReportRequest({
      ...VALID_FORM,
      includeDesktopLog: false,
      includeHostLog: true,
    });
    expect(result.includeDesktopLog).toBe(false);
    expect(result.includeHostLog).toBe(true);
  });

  it("rejects a missing includeDiagnostics key", () => {
    const { includeDiagnostics: _includeDiagnostics, ...withoutKey } =
      VALID_FORM;
    expect(() => parseSupportSubmitReportRequest(withoutKey)).toThrow();
  });

  it("rejects a non-boolean includeDiagnostics", () => {
    expect(() =>
      parseSupportSubmitReportRequest({
        ...VALID_FORM,
        includeDiagnostics: "yes",
      }),
    ).toThrow();
  });

  it.each([true, false])("accepts includeDiagnostics %s", (value) => {
    const result = parseSupportSubmitReportRequest({
      ...VALID_FORM,
      includeDiagnostics: value,
    });
    expect(result.includeDiagnostics).toBe(value);
  });

  it("rejects a missing overrideTitle key - the wire always carries it", () => {
    const { overrideTitle: _overrideTitle, ...withoutKey } = VALID_FORM;
    expect(() => parseSupportSubmitReportRequest(withoutKey)).toThrow();
  });

  it("accepts a null overrideTitle - the initial preview fetch", () => {
    const result = parseSupportSubmitReportRequest({
      ...VALID_FORM,
      overrideTitle: null,
    });
    expect(result.overrideTitle).toBeNull();
  });

  it("accepts a non-null overrideTitle - the user's as-typed preview edit", () => {
    const result = parseSupportSubmitReportRequest({
      ...VALID_FORM,
      overrideTitle: "Edited title",
    });
    expect(result.overrideTitle).toBe("Edited title");
  });

  it("rejects a non-string non-null overrideTitle", () => {
    expect(() =>
      parseSupportSubmitReportRequest({ ...VALID_FORM, overrideTitle: 42 }),
    ).toThrow();
  });

  it("rejects a missing privateOutcome key", () => {
    const { privateOutcome: _privateOutcome, ...withoutKey } = VALID_FORM;
    expect(() => parseSupportSubmitReportRequest(withoutKey)).toThrow();
  });

  it.each(["delivered", "unconfirmed", "none"])(
    "accepts privateOutcome %s",
    (privateOutcome) => {
      const result = parseSupportSubmitReportRequest({
        ...VALID_FORM,
        privateOutcome,
      });
      expect(result.privateOutcome).toBe(privateOutcome);
    },
  );

  it("rejects a privateOutcome outside delivered/unconfirmed/none", () => {
    expect(() =>
      parseSupportSubmitReportRequest({
        ...VALID_FORM,
        privateOutcome: "failed",
      }),
    ).toThrow();
  });

  it("rejects an unlisted top-level field - the allowlist is not caller-discipline", () => {
    expect(() =>
      parseSupportSubmitReportRequest({
        ...VALID_FORM,
        secretPayload: { anything: "goes" },
      }),
    ).toThrow();
  });

  it("accepts a fully-populated privateDiagnostics payload", () => {
    const result = parseSupportSubmitReportRequest({
      ...VALID_FORM,
      privateDiagnostics: VALID_PRIVATE_DIAGNOSTICS,
    });
    expect(result.privateDiagnostics).toEqual(VALID_PRIVATE_DIAGNOSTICS);
  });

  it("accepts a null cause, fingerprint, and stackFamily - all real, non-error states", () => {
    const result = parseSupportSubmitReportRequest({
      ...VALID_FORM,
      privateDiagnostics: {
        ...VALID_PRIVATE_DIAGNOSTICS,
        cause: null,
        fingerprint: null,
        stackFamily: null,
      },
    });
    expect(result.privateDiagnostics?.cause).toBeNull();
    expect(result.privateDiagnostics?.fingerprint).toBeNull();
    expect(result.privateDiagnostics?.stackFamily).toBeNull();
  });

  it.each(["cause", "registry", "fingerprint", "stackFamily", "correlationId"])(
    "rejects privateDiagnostics missing the required %s key - the serializer never omits it",
    (key) => {
      const withoutKey = { ...VALID_PRIVATE_DIAGNOSTICS };
      delete (withoutKey as Record<string, unknown>)[key];
      expect(() =>
        parseSupportSubmitReportRequest({
          ...VALID_FORM,
          privateDiagnostics: withoutKey,
        }),
      ).toThrow();
    },
  );

  it("rejects a non-string correlationId", () => {
    expect(() =>
      parseSupportSubmitReportRequest({
        ...VALID_FORM,
        privateDiagnostics: { ...VALID_PRIVATE_DIAGNOSTICS, correlationId: 1 },
      }),
    ).toThrow();
  });

  it("rejects an unlisted key inside privateDiagnostics", () => {
    expect(() =>
      parseSupportSubmitReportRequest({
        ...VALID_FORM,
        privateDiagnostics: { ...VALID_PRIVATE_DIAGNOSTICS, extra: true },
      }),
    ).toThrow();
  });

  it("rejects an unlisted key inside privateDiagnostics.cause", () => {
    expect(() =>
      parseSupportSubmitReportRequest({
        ...VALID_FORM,
        privateDiagnostics: {
          ...VALID_PRIVATE_DIAGNOSTICS,
          cause: { ...VALID_CAUSE, workspacePath: "/Users/anurag/secret" },
        },
      }),
    ).toThrow();
  });

  it("rejects a non-finite timestamp in privateDiagnostics.cause", () => {
    expect(() =>
      parseSupportSubmitReportRequest({
        ...VALID_FORM,
        privateDiagnostics: {
          ...VALID_PRIVATE_DIAGNOSTICS,
          cause: { ...VALID_CAUSE, timestamp: Number.NaN },
        },
      }),
    ).toThrow();
  });

  it("rejects an unlisted key inside privateDiagnostics.registry", () => {
    expect(() =>
      parseSupportSubmitReportRequest({
        ...VALID_FORM,
        privateDiagnostics: {
          ...VALID_PRIVATE_DIAGNOSTICS,
          registry: { ...VALID_REGISTRY, rawFilePath: "/etc/passwd" },
        },
      }),
    ).toThrow();
  });

  it("rejects a providerSelectionClass value outside bundled/path/custom", () => {
    expect(() =>
      parseSupportSubmitReportRequest({
        ...VALID_FORM,
        privateDiagnostics: {
          ...VALID_PRIVATE_DIAGNOSTICS,
          registry: {
            ...VALID_REGISTRY,
            providerSelectionClass: { status: "known", value: "vendored" },
          },
        },
      }),
    ).toThrow();
  });

  it.each(["known", "stale", "unavailable"])(
    "accepts a registry field with status %s",
    (status) => {
      const field =
        status === "unavailable" ? UNAVAILABLE : { status, value: "epic-2" };
      const result = parseSupportSubmitReportRequest({
        ...VALID_FORM,
        privateDiagnostics: {
          ...VALID_PRIVATE_DIAGNOSTICS,
          registry: { ...VALID_REGISTRY, epicId: field },
        },
      });
      expect(result.privateDiagnostics?.registry.epicId).toEqual(field);
    },
  );

  it("rejects a registry field with an unrecognized status", () => {
    expect(() =>
      parseSupportSubmitReportRequest({
        ...VALID_FORM,
        privateDiagnostics: {
          ...VALID_PRIVATE_DIAGNOSTICS,
          registry: {
            ...VALID_REGISTRY,
            epicId: { status: "fresh", value: "epic-1" },
          },
        },
      }),
    ).toThrow();
  });

  it("rejects a known registry field missing its value", () => {
    expect(() =>
      parseSupportSubmitReportRequest({
        ...VALID_FORM,
        privateDiagnostics: {
          ...VALID_PRIVATE_DIAGNOSTICS,
          registry: { ...VALID_REGISTRY, epicId: { status: "known" } },
        },
      }),
    ).toThrow();
  });

  it("rejects nullable known or stale fields missing their value", () => {
    for (const field of ["profileId", "providerVersion"] as const) {
      expect(() =>
        parseSupportSubmitReportRequest({
          ...VALID_FORM,
          privateDiagnostics: {
            ...VALID_PRIVATE_DIAGNOSTICS,
            registry: {
              ...VALID_REGISTRY,
              [field]: { status: "known" },
            },
          },
        }),
      ).toThrow(/missing required field: value/);
    }
  });

  it("rejects an unavailable registry field carrying a stray value", () => {
    expect(() =>
      parseSupportSubmitReportRequest({
        ...VALID_FORM,
        privateDiagnostics: {
          ...VALID_PRIVATE_DIAGNOSTICS,
          registry: {
            ...VALID_REGISTRY,
            epicId: { status: "unavailable", value: "epic-1" },
          },
        },
      }),
    ).toThrow();
  });

  describe("images", () => {
    it("accepts an empty images array", () => {
      const result = parseSupportSubmitReportRequest(VALID_FORM);
      expect(result.images).toEqual([]);
    });

    it("rejects a missing images key - the wire always carries it", () => {
      const { images: _images, ...withoutImages } = VALID_FORM;
      expect(() => parseSupportSubmitReportRequest(withoutImages)).toThrow();
    });

    it("rejects a non-array images value", () => {
      expect(() =>
        parseSupportSubmitReportRequest({ ...VALID_FORM, images: null }),
      ).toThrow();
      expect(() =>
        parseSupportSubmitReportRequest({ ...VALID_FORM, images: {} }),
      ).toThrow();
    });

    it.each([
      ["image/png", SMALL_PNG()],
      ["image/jpeg", SMALL_JPEG()],
      ["image/jpg", SMALL_JPEG()],
      ["image/gif", SMALL_GIF()],
      ["image/webp", SMALL_WEBP()],
    ] as const)("accepts a well-formed %s attachment", (mimeType, bytes) => {
      const result = parseSupportSubmitReportRequest({
        ...VALID_FORM,
        images: [
          imageAttachment({
            fileName: undefined,
            mimeType,
            bytes,
          }),
        ],
      });
      expect(result.images).toHaveLength(1);
      expect(result.images[0]?.mimeType).toBe(mimeType);
      expect(result.images[0]?.bytes).toBe(bytes);
    });

    it("accepts up to MAX_REPORT_IMAGES attachments", () => {
      const images = Array.from({ length: MAX_REPORT_IMAGES }, (_, i) =>
        imageAttachment({
          fileName: `shot-${i}.png`,
          mimeType: undefined,
          bytes: undefined,
        }),
      );
      const result = parseSupportSubmitReportRequest({
        ...VALID_FORM,
        images,
      });
      expect(result.images).toHaveLength(MAX_REPORT_IMAGES);
    });

    it("rejects more than MAX_REPORT_IMAGES attachments", () => {
      const images = Array.from({ length: MAX_REPORT_IMAGES + 1 }, (_, i) =>
        imageAttachment({
          fileName: `shot-${i}.png`,
          mimeType: undefined,
          bytes: undefined,
        }),
      );
      expect(() =>
        parseSupportSubmitReportRequest({ ...VALID_FORM, images }),
      ).toThrow(/at most 3 images/);
    });

    it("rejects an attachment with an unlisted key", () => {
      expect(() =>
        parseSupportSubmitReportRequest({
          ...VALID_FORM,
          images: [{ ...defaultImageAttachment(), extra: true }],
        }),
      ).toThrow();
    });

    it("rejects an attachment missing a required key", () => {
      const { fileName: _fileName, ...withoutName } = defaultImageAttachment();
      expect(() =>
        parseSupportSubmitReportRequest({
          ...VALID_FORM,
          images: [withoutName],
        }),
      ).toThrow();
    });

    it("rejects a non-string fileName or mimeType", () => {
      // Build malformed payloads without type assertions: the parser takes
      // `unknown`, so a Record with the wrong runtime types is enough.
      const badFileName: Record<string, unknown> = {
        fileName: 42,
        mimeType: "image/png",
        bytes: SMALL_PNG(),
      };
      const badMimeType: Record<string, unknown> = {
        fileName: "shot.png",
        mimeType: 42,
        bytes: SMALL_PNG(),
      };
      expect(() =>
        parseSupportSubmitReportRequest({
          ...VALID_FORM,
          images: [badFileName],
        }),
      ).toThrow();
      expect(() =>
        parseSupportSubmitReportRequest({
          ...VALID_FORM,
          images: [badMimeType],
        }),
      ).toThrow();
    });

    it("rejects bytes that are not an ArrayBuffer instance", () => {
      const uint8Payload: Record<string, unknown> = {
        fileName: "shot.png",
        mimeType: "image/png",
        bytes: new Uint8Array(SMALL_PNG()),
      };
      const bufferPayload: Record<string, unknown> = {
        fileName: "shot.png",
        mimeType: "image/png",
        bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
      };
      expect(() =>
        parseSupportSubmitReportRequest({
          ...VALID_FORM,
          images: [uint8Payload],
        }),
      ).toThrow();
      expect(() =>
        parseSupportSubmitReportRequest({
          ...VALID_FORM,
          images: [bufferPayload],
        }),
      ).toThrow();
    });

    it("rejects an unsupported mimeType such as image/svg+xml", () => {
      expect(() =>
        parseSupportSubmitReportRequest({
          ...VALID_FORM,
          images: [
            imageAttachment({
              fileName: undefined,
              mimeType: "image/svg+xml",
              bytes: SMALL_PNG(),
            }),
          ],
        }),
      ).toThrow(/image\/png, image\/jpeg, image\/jpg, image\/gif, image\/webp/);
    });

    it("rejects empty bytes", () => {
      expect(() =>
        parseSupportSubmitReportRequest({
          ...VALID_FORM,
          images: [
            imageAttachment({
              fileName: undefined,
              mimeType: undefined,
              bytes: new ArrayBuffer(0),
            }),
          ],
        }),
      ).toThrow(/empty/);
    });

    it("rejects bytes larger than MAX_REPORT_IMAGE_BYTES", () => {
      const oversized = pngArrayBuffer(MAX_REPORT_IMAGE_BYTES + 1);
      expect(oversized.byteLength).toBe(MAX_REPORT_IMAGE_BYTES + 1);
      expect(() =>
        parseSupportSubmitReportRequest({
          ...VALID_FORM,
          images: [
            imageAttachment({
              fileName: undefined,
              mimeType: undefined,
              bytes: oversized,
            }),
          ],
        }),
      ).toThrow(/limit/);
    });

    it("rejects magic bytes that do not match the declared media type", () => {
      // PNG magic declared as JPEG
      expect(() =>
        parseSupportSubmitReportRequest({
          ...VALID_FORM,
          images: [
            imageAttachment({
              fileName: undefined,
              mimeType: "image/jpeg",
              bytes: SMALL_PNG(),
            }),
          ],
        }),
      ).toThrow(/does not match declared type/);
    });

    it("accepts three max-size images (still under the total budget)", () => {
      // Arithmetic: 3 * 5 MiB = 15_728_640; budget ceiling for images is
      // TOTAL - 2 * LOG = 20_971_520 - 1_024_000 = 19_947_520. Headroom is
      // intentional (ticket 08 / G5).
      const images = Array.from({ length: MAX_REPORT_IMAGES }, (_, i) =>
        imageAttachment({
          fileName: `max-${i}.png`,
          mimeType: undefined,
          bytes: pngArrayBuffer(MAX_REPORT_IMAGE_BYTES),
        }),
      );
      const total = images.reduce((sum, img) => sum + img.bytes.byteLength, 0);
      expect(total + 2 * REPORT_LOG_TAIL_MAX_BYTES).toBeLessThanOrEqual(
        TOTAL_ATTACHMENT_BUDGET_BYTES,
      );
      const result = parseSupportSubmitReportRequest({
        ...VALID_FORM,
        images,
      });
      expect(result.images).toHaveLength(MAX_REPORT_IMAGES);
    });

    it("rejects a payload larger than the per-image size limit before the budget check", () => {
      // With current constants, MAX_REPORT_IMAGES * MAX_REPORT_IMAGE_BYTES
      // (15_728_640) is still under the budget ceiling
      // (TOTAL - 2*LOG = 19_947_520), so a pure budget-exceed path is not
      // reachable through valid per-image sizes. The size gate fires first
      // for any buffer large enough to threaten the total budget alone.
      // Predicate boundary coverage lives in image-attachment-guards.test.ts.
      const maxFitting =
        TOTAL_ATTACHMENT_BUDGET_BYTES - 2 * REPORT_LOG_TAIL_MAX_BYTES;
      expect(MAX_REPORT_IMAGES * MAX_REPORT_IMAGE_BYTES).toBeLessThan(
        maxFitting,
      );
      expect(maxFitting).toBeGreaterThan(MAX_REPORT_IMAGE_BYTES);
      expect(() =>
        parseSupportSubmitReportRequest({
          ...VALID_FORM,
          images: [
            imageAttachment({
              fileName: undefined,
              mimeType: undefined,
              bytes: pngArrayBuffer(maxFitting),
            }),
          ],
        }),
      ).toThrow(/limit/);
    });
  });

  // G15: mirrors the dialog's own evidence gate at the wire boundary - a
  // sentence, a screenshot, a location, or a captured error each
  // independently satisfy it; only genuinely nothing at all is rejected.
  describe("submittable-evidence gate (G15)", () => {
    it("accepts an empty intent when at least one image is attached", () => {
      const result = parseSupportSubmitReportRequest({
        ...VALID_FORM,
        intent: "",
        images: [defaultImageAttachment()],
      });
      expect(result.intent).toBe("");
      expect(result.images).toHaveLength(1);
    });

    it("rejects an empty intent with no images, location, or captured error", () => {
      expect(() =>
        parseSupportSubmitReportRequest({
          ...VALID_FORM,
          intent: "",
          location: null,
          images: [],
        }),
      ).toThrow(
        /requires a sentence, a screenshot, a location, or a captured error/,
      );
    });

    it("rejects an intent of only whitespace with no other evidence", () => {
      expect(() =>
        parseSupportSubmitReportRequest({
          ...VALID_FORM,
          intent: "   \n\t",
          location: null,
          images: [],
        }),
      ).toThrow();
    });

    it("accepts an empty intent when a bug location was actively changed", () => {
      const result = parseSupportSubmitReportRequest({
        ...VALID_FORM,
        intent: "",
        location: "Chat",
        images: [],
      });
      expect(result.intent).toBe("");
      expect(result.location).toBe("Chat");
    });

    it("rejects a blank location when no other evidence is present", () => {
      expect(() =>
        parseSupportSubmitReportRequest({
          ...VALID_FORM,
          intent: "",
          location: "  \n\t",
          images: [],
        }),
      ).toThrow(
        /requires a sentence, a screenshot, a location, or a captured error/,
      );
    });

    it("accepts an empty intent for an error-triggered report (a captured cause is its own evidence)", () => {
      const result = parseSupportSubmitReportRequest({
        ...VALID_FORM,
        intent: "",
        location: null,
        images: [],
        privateDiagnostics: VALID_PRIVATE_DIAGNOSTICS,
      });
      expect(result.intent).toBe("");
    });

    it("accepts an empty intent when privateDiagnostics carries only a fingerprint (no structured cause)", () => {
      const result = parseSupportSubmitReportRequest({
        ...VALID_FORM,
        intent: "",
        location: null,
        images: [],
        privateDiagnostics: {
          ...VALID_PRIVATE_DIAGNOSTICS,
          cause: null,
        },
      });
      expect(result.intent).toBe("");
    });

    it("still rejects an empty intent when privateDiagnostics has neither a cause nor a fingerprint (KB2's legacy-context shape)", () => {
      expect(() =>
        parseSupportSubmitReportRequest({
          ...VALID_FORM,
          intent: "",
          location: null,
          images: [],
          privateDiagnostics: {
            ...VALID_PRIVATE_DIAGNOSTICS,
            cause: null,
            fingerprint: null,
          },
        }),
      ).toThrow(
        /requires a sentence, a screenshot, a location, or a captured error/,
      );
    });
  });
});

describe("parseSupportReadFrozenLogTailInput", () => {
  it("accepts a well-formed input", () => {
    expect(
      parseSupportReadFrozenLogTailInput({ draftId: 1, target: "host" }),
    ).toEqual({ draftId: 1, target: "host" });
  });

  it("rejects a non-number draftId", () => {
    expect(() =>
      parseSupportReadFrozenLogTailInput({ draftId: "1", target: "host" }),
    ).toThrow();
  });

  it("rejects an unrecognized target instead of failing open", () => {
    // Strict rejection everywhere: an unrecognized target used to silently
    // fall back to "desktop", which is exactly the caller-discipline pattern
    // this whole contract exists to close off.
    expect(() =>
      parseSupportReadFrozenLogTailInput({ draftId: 1, target: "nonsense" }),
    ).toThrow();
  });

  it("rejects a non-integer draftId", () => {
    expect(() =>
      parseSupportReadFrozenLogTailInput({ draftId: 1.5, target: "host" }),
    ).toThrow();
  });

  it("rejects an unlisted top-level field", () => {
    expect(() =>
      parseSupportReadFrozenLogTailInput({
        draftId: 1,
        target: "host",
        extra: true,
      }),
    ).toThrow();
  });
});

describe("parseSupportFreezeEvidenceInput", () => {
  it("accepts a well-formed input with a fingerprint", () => {
    expect(
      parseSupportFreezeEvidenceInput({
        draftId: 1,
        fingerprint: "fp:v1:abc",
      }),
    ).toEqual({ draftId: 1, fingerprint: "fp:v1:abc" });
  });

  it("accepts a null fingerprint - the manual-open / no-envelope case", () => {
    expect(
      parseSupportFreezeEvidenceInput({ draftId: 2, fingerprint: null }),
    ).toEqual({ draftId: 2, fingerprint: null });
  });

  it("rejects a missing fingerprint key - the wire always carries it", () => {
    expect(() => parseSupportFreezeEvidenceInput({ draftId: 1 })).toThrow();
  });

  it("rejects a non-integer draftId", () => {
    expect(() =>
      parseSupportFreezeEvidenceInput({
        draftId: 1.5,
        fingerprint: null,
      }),
    ).toThrow();
  });

  it("rejects a non-string non-null fingerprint", () => {
    expect(() =>
      parseSupportFreezeEvidenceInput({ draftId: 1, fingerprint: 42 }),
    ).toThrow();
  });

  it("rejects an unlisted top-level field", () => {
    expect(() =>
      parseSupportFreezeEvidenceInput({
        draftId: 1,
        fingerprint: null,
        extra: true,
      }),
    ).toThrow();
  });

  it("rejects a bare draftId number - the pre-ledger shape", () => {
    expect(() => parseSupportFreezeEvidenceInput(1)).toThrow();
  });
});
