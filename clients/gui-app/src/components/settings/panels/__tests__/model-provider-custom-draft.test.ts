import { describe, expect, it } from "vitest";
import {
  canReenableCustomProvider,
  customProviderDraftFrom,
  customProviderKeyOf,
  customProviderValues,
  customProviderValuesOf,
  emptyCustomProviderDraft,
  hasCustomProviderDraftError,
  suggestCustomProviderId,
  validateCustomProviderDraft,
  type CustomProviderDraft,
  type CustomProviderHeaderRow,
  type CustomProviderModelRow,
} from "@/components/settings/panels/model-provider-custom-draft";

/**
 * These assert OPENCODE's rules, mirrored from its own custom-provider form.
 * Where one looks lax, the note says why: mirroring a validation rule means
 * adopting its edges too, and a stricter check would refuse inputs their app
 * accepts.
 */

/** Declaring a new provider: the minting rules apply. */
const CREATE = { takenIds: [], disabledIds: [], existing: false };
/** A value that came off an existing row: only the hazard rule applies. */
const EXISTING = { takenIds: [], disabledIds: [], existing: true };

/**
 * A row TYPED in this session: removable, and its key still the form's to
 * judge. The stored counterpart is locked - see the `stored rows` block.
 */
function typedModel(
  row: string,
  id: string,
  name: string,
): CustomProviderModelRow {
  return { row, id, name, locked: false };
}

function typedHeader(
  row: string,
  key: string,
  value: string,
): CustomProviderHeaderRow {
  return { row, key, value, locked: false };
}

function draft(overrides: Partial<CustomProviderDraft>): CustomProviderDraft {
  return {
    ...emptyCustomProviderDraft(),
    providerId: "myprovider",
    name: "My AI Provider",
    baseUrl: "https://api.myprovider.com/v1",
    models: [typedModel("m1", "model-id", "Display Name")],
    ...overrides,
  };
}

describe("provider id", () => {
  it("allows underscores, which upstream's rule does", () => {
    // Ours banned them, which refused ids the host accepts and condemned
    // existing declarations that already used one.
    expect(
      validateCustomProviderDraft(draft({ providerId: "my_provider" }), CREATE)
        .providerId,
    ).toBeNull();
  });

  it("still requires the first character to be alphanumeric", () => {
    expect(
      validateCustomProviderDraft(draft({ providerId: "_leading" }), CREATE)
        .providerId,
    ).toBe("Use lowercase letters, numbers, hyphens, or underscores");
  });

  it("names the hazard as a hazard, on both paths", () => {
    // The pattern would reject `__proto__` on the minting path anyway, but the
    // hazard is checked FIRST so it reports itself rather than being filed as a
    // style violation - the same message the user sees if it ever arrives on a
    // row.
    expect(
      validateCustomProviderDraft(draft({ providerId: "__proto__" }), CREATE)
        .providerId,
    ).toBe("That provider ID isn't allowed");
  });

  it("refuses __proto__ even when it arrived on a row", () => {
    expect(
      validateCustomProviderDraft(draft({ providerId: "__proto__" }), EXISTING)
        .providerId,
    ).toBe("That provider ID isn't allowed");
  });

  it("does not judge an EXISTING id by the minting pattern", () => {
    expect(
      validateCustomProviderDraft(draft({ providerId: "My.Gateway" }), EXISTING)
        .providerId,
    ).toBeNull();
  });

  it("treats a DISABLED id as available, because re-declaring re-enables it", () => {
    // Upstream skips the exists-check for anything in `disabled_providers`;
    // reporting it as taken would block the one flow that repairs the row.
    expect(
      validateCustomProviderDraft(draft({ providerId: "mine" }), {
        takenIds: ["mine"],
        disabledIds: ["mine"],
        existing: false,
      }).providerId,
    ).toBeNull();
    expect(
      validateCustomProviderDraft(draft({ providerId: "mine" }), {
        takenIds: ["mine"],
        disabledIds: [],
        existing: false,
      }).providerId,
    ).toBe("That provider ID already exists");
  });

  it("proposes an id from the display name", () => {
    // Ours; upstream makes you type it. Dashes because that is what the
    // catalog's own ids look like - both separators are legal.
    expect(suggestCustomProviderId("  My Gateway (EU) ")).toBe("my-gateway-eu");
  });
});

describe("base URL", () => {
  it("is a PREFIX test, not a URL parse", () => {
    // `https://` alone satisfies upstream, and a parse would reject inputs
    // their form accepts. Whether the endpoint answers is not knowable here.
    expect(
      validateCustomProviderDraft(draft({ baseUrl: "https://" }), CREATE)
        .baseUrl,
    ).toBeNull();
    expect(
      validateCustomProviderDraft(
        draft({ baseUrl: "api.example.test" }),
        CREATE,
      ).baseUrl,
    ).toBe("Must start with http:// or https://");
  });

  it("accepts http for a local gateway", () => {
    expect(
      validateCustomProviderDraft(
        draft({ baseUrl: "http://localhost:11434/v1" }),
        CREATE,
      ).baseUrl,
    ).toBeNull();
  });
});

describe("model rows", () => {
  it("requires an id AND a display name per row", () => {
    const errors = validateCustomProviderDraft(
      draft({ models: [typedModel("m1", "", "")] }),
      CREATE,
    );
    expect(errors.models[0]).toEqual({ first: "Required", second: "Required" });
  });

  it("compares ids case-SENSITIVELY", () => {
    // A model id is sent to the endpoint verbatim; `GPT-4o` is not `gpt-4o`.
    const errors = validateCustomProviderDraft(
      draft({
        models: [
          typedModel("m1", "gpt-4o", "One"),
          typedModel("m2", "GPT-4o", "Two"),
          typedModel("m3", "gpt-4o", "Three"),
        ],
      }),
      CREATE,
    );
    expect(errors.models[1].first).toBeNull();
    expect(errors.models[2].first).toBe("Duplicate");
  });
});

describe("header rows", () => {
  it("skips a wholly empty row instead of flagging it", () => {
    // The list always carries a blank row and the section is optional, so
    // complaining about the unused one would make every valid form invalid.
    const errors = validateCustomProviderDraft(draft({}), CREATE);
    expect(errors.headers[0]).toEqual({ first: null, second: null });
    expect(hasCustomProviderDraftError(errors)).toBe(false);
  });

  it("requires the other half once either is typed", () => {
    const errors = validateCustomProviderDraft(
      draft({ headers: [typedHeader("h1", "X-Key", "")] }),
      CREATE,
    );
    expect(errors.headers[0]).toEqual({ first: null, second: "Required" });
  });

  it("compares names case-INSENSITIVELY", () => {
    // HTTP header names are, and two rows differing only in case would collapse
    // silently when written.
    const errors = validateCustomProviderDraft(
      draft({
        headers: [
          typedHeader("h1", "X-Key", "a"),
          typedHeader("h2", "x-key", "b"),
        ],
      }),
      CREATE,
    );
    expect(errors.headers[1].first).toBe("Duplicate");
  });
});

describe("the API key field", () => {
  it("reads {env:VAR} as a REFERENCE, not a secret", () => {
    // Upstream's syntax: the config block gets `env: ["VAR"]` and no credential
    // is stored.
    expect(customProviderKeyOf("{env:OPENAI_KEY}")).toEqual({
      key: null,
      env: ["OPENAI_KEY"],
    });
  });

  it("reads anything else as the secret itself", () => {
    expect(customProviderKeyOf(" sk-live-123 ")).toEqual({
      key: "sk-live-123",
      env: [],
    });
  });

  it("reads empty as neither", () => {
    expect(customProviderKeyOf("   ")).toEqual({ key: null, env: [] });
  });
});

describe("values for the wire", () => {
  it("carries models, headers and the credential in the wire's shape", () => {
    expect(
      customProviderValues(
        draft({
          // A typed key: the field only replaces what the row arrived with once
          // it has been edited.
          apiKey: "sk-live-123",
          apiKeyEdited: true,
          models: [typedModel("m1", " a ", " A ")],
          headers: [
            typedHeader("h1", " X-Key ", " v "),
            typedHeader("h2", "", ""),
          ],
        }),
        CREATE,
      ),
    ).toEqual({
      modelProviderId: "myprovider",
      name: "My AI Provider",
      baseUrl: "https://api.myprovider.com/v1",
      models: [{ id: "a", name: "A" }],
      // The trailing blank row is not a header the endpoint should be sent.
      headers: [{ key: "X-Key", value: "v" }],
      key: "sk-live-123",
      env: [],
    });
  });

  it("answers null rather than a half-built payload", () => {
    expect(
      customProviderValues(
        draft({ models: [typedModel("m1", "a", "")] }),
        CREATE,
      ),
    ).toBeNull();
  });
});

describe("editing an existing declaration", () => {
  const values = {
    modelProviderId: "myprovider",
    name: "My AI Provider",
    baseUrl: "https://api.myprovider.com/v1",
    models: [{ id: "a", name: "A" }],
    headers: [{ key: "X-Key", value: "v" }],
    key: null,
    env: [],
  };

  it("opens with an EMPTY key field, because the stored one is never read back", () => {
    // And empty must therefore mean "leave it alone" - not "clear it".
    expect(customProviderDraftFrom(values).apiKey).toBe("");
  });

  it("restores a SINGLE env reference verbatim, because the field can hold it", () => {
    expect(
      customProviderDraftFrom({ ...values, env: ["OPENAI_KEY"] }).apiKey,
    ).toBe("{env:OPENAI_KEY}");
  });

  it("keeps EVERY env fallback across an untouched Edit", () => {
    // One field cannot show two references, and rendering `env[0]` alone meant
    // saving an untouched form silently dropped `env[1]`. Untouched now says so
    // in the wire's own word - `null`, leave the declaration alone - rather than
    // resending an array this form only half understands. `[]` would CLEAR it,
    // which is the bug this distinction exists to make unspellable by accident.
    const two = { ...values, env: ["KEY_A", "KEY_B"] };
    const draft = customProviderDraftFrom(two);
    expect(draft.apiKey).toBe("");
    expect(
      customProviderValues(draft, {
        takenIds: [],
        disabledIds: [],
        existing: true,
      }),
    ).toMatchObject({ key: null, env: null });
  });

  it("CLEARS the fallbacks when a restored reference is deleted", () => {
    // The other half of the same distinction: an edited-to-empty field is an
    // instruction, not an absence. A single reference is the only case the
    // field can show, so it is the only case a user can delete by hand - and
    // when they do, `[]` says exactly that.
    const one = { ...values, env: ["OPENAI_KEY"] };
    const cleared = {
      ...customProviderDraftFrom(one),
      apiKey: "",
      apiKeyEdited: true,
    };
    expect(
      customProviderValues(cleared, {
        takenIds: [],
        disabledIds: [],
        existing: true,
      }),
    ).toMatchObject({ key: null, env: [] });
  });

  it("replaces the fallbacks once the field is edited", () => {
    const two = { ...values, env: ["KEY_A", "KEY_B"] };
    const edited = {
      ...customProviderDraftFrom(two),
      apiKey: "{env:KEY_C}",
      apiKeyEdited: true,
    };
    expect(
      customProviderValues(edited, {
        takenIds: [],
        disabledIds: [],
        existing: true,
      }),
    ).toMatchObject({ key: null, env: ["KEY_C"] });
  });

  it("prefills rows from the row's own values", () => {
    const prefilled = customProviderDraftFrom(values);
    expect(prefilled.models.map((row) => [row.id, row.name])).toEqual([
      ["a", "A"],
    ]);
    expect(prefilled.headers.map((row) => [row.key, row.value])).toEqual([
      ["X-Key", "v"],
    ]);
  });

  it("marks the rows that came off the CONFIG as stored", () => {
    // The lock is provenance, not position: these are the rows the deep merge
    // can no longer be told to delete.
    const prefilled = customProviderDraftFrom(values);
    expect(prefilled.models.map((row) => row.locked)).toEqual([true]);
    expect(prefilled.headers.map((row) => row.locked)).toEqual([true]);
  });

  it("does NOT lock the blank row substituted for an empty list", () => {
    // Nothing is stored under it, so there is nothing to orphan - locking it
    // would strand a declaration with no models behind an unusable form.
    const empty = customProviderDraftFrom({
      ...values,
      models: [],
      headers: [],
    });
    expect(empty.models.map((row) => row.locked)).toEqual([false]);
    expect(empty.headers.map((row) => row.locked)).toEqual([false]);
  });

  it("does not judge a STORED key, but still judges what sits beside it", () => {
    // Same reasoning as an existing provider id: the value came off a
    // hand-editable file rather than out of this form, and the field is
    // read-only - so a complaint there is one the user cannot act on, and it
    // would strand the only surface that can repair the rest of the row. The
    // display name is editable, so its complaint stays.
    const broken = {
      ...customProviderDraftFrom(values),
      models: [{ row: "m1", id: "", name: "", locked: true }],
    };
    expect(validateCustomProviderDraft(broken, EXISTING).models[0]).toEqual({
      first: null,
      second: "Required",
    });
  });

  it("still flags a NEW row that collides with a stored key", () => {
    // The stored key is unjudged, not invisible: the duplicate is reported on
    // the row that can actually change.
    const collide = {
      ...customProviderDraftFrom(values),
      models: [
        { row: "m1", id: "a", name: "A", locked: true },
        { row: "m2", id: "a", name: "Also A", locked: false },
      ],
    };
    const errors = validateCustomProviderDraft(collide, EXISTING);
    expect(errors.models[0].first).toBeNull();
    expect(errors.models[1].first).toBe("Duplicate");
  });

  it("reads an entry's declared values off the wire", () => {
    expect(
      customProviderValuesOf({
        id: "myprovider",
        name: "My AI Provider",
        custom: {
          // Deliberately malformed: the read side reports what it finds, so
          // Edit can open on the row that needs fixing.
          baseUrl: "api.myprovider.com/v1",
          models: [{ id: "a", name: "A" }],
          headers: [{ key: "X-Key", value: "v" }],
          env: ["OPENAI_KEY"],
        },
      }),
    ).toEqual({
      modelProviderId: "myprovider",
      name: "My AI Provider",
      baseUrl: "api.myprovider.com/v1",
      models: [{ id: "a", name: "A" }],
      headers: [{ key: "X-Key", value: "v" }],
      key: null,
      env: ["OPENAI_KEY"],
    });
  });

  it("answers null for a row that is not a declared custom one", () => {
    expect(
      customProviderValuesOf({ id: "openai", name: "OpenAI", custom: null }),
    ).toBeNull();
  });
});

describe("re-enable eligibility", () => {
  const values = {
    modelProviderId: "myprovider",
    name: "My AI Provider",
    baseUrl: "https://api.myprovider.com/v1",
    models: [{ id: "a", name: "A" }],
    headers: [],
    key: null,
    env: [],
  };

  it("allows a declaration the write side would accept", () => {
    expect(canReenableCustomProvider(values)).toBe(true);
    // Including a hand-written id we would never have minted.
    expect(
      canReenableCustomProvider({ ...values, modelProviderId: "my_provider" }),
    ).toBe(true);
  });

  it("judges the row's REAL headers, not a blank set", () => {
    // Re-enable submits `updateCustom` with the row's own headers, so viability
    // has to be decided about that payload. Judging a blank header list judged
    // a different write than the one that would go out.
    expect(
      canReenableCustomProvider({
        ...values,
        headers: [{ key: "X-Org", value: "acme" }],
      }),
    ).toBe(true);
    // Two header names differing only in case collapse when written, so our
    // write path refuses them - and re-enable must refuse them too rather than
    // sending a payload it would reject from the form.
    expect(
      canReenableCustomProvider({
        ...values,
        headers: [
          { key: "X-Org", value: "acme" },
          { key: "x-org", value: "other" },
        ],
      }),
    ).toBe(false);
  });

  it("refuses one the write side would reject", () => {
    // Sending it back would report a failure the user never had a chance to
    // fix; that row gets Edit instead.
    expect(
      canReenableCustomProvider({ ...values, baseUrl: "api.example.test" }),
    ).toBe(false);
    expect(canReenableCustomProvider({ ...values, models: [] })).toBe(false);
    // A model row missing its display name fails upstream's rule too.
    expect(
      canReenableCustomProvider({ ...values, models: [{ id: "a", name: "" }] }),
    ).toBe(false);
  });
});
