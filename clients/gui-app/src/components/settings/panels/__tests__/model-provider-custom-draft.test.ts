import { describe, expect, it } from "vitest";
import {
  canReenableCustomProvider,
  customProviderValues,
  customProviderValuesOf,
  hasCustomProviderDraftError,
  parseCustomProviderModels,
  suggestCustomProviderId,
  validateCustomProviderDraft,
  type CustomProviderDraft,
} from "@/components/settings/panels/model-provider-custom-draft";

/** Declaring a new provider: the minting rules apply. */
const CREATE = { takenIds: [], existing: false };
/** A value that came off an existing row: only the hazard rule applies. */
const EXISTING = { takenIds: [], existing: true };

function draft(overrides: Partial<CustomProviderDraft>): CustomProviderDraft {
  return {
    id: "my-gateway",
    name: "My gateway",
    baseUrl: "https://api.example.test/v1",
    models: "gpt-4o-mini",
    ...overrides,
  };
}

describe("custom provider id suggestion", () => {
  it("turns a typed name into a usable config key", () => {
    expect(suggestCustomProviderId("  My Gateway (EU) ")).toBe("my-gateway-eu");
  });

  it("never proposes a leading or trailing dash", () => {
    // The id pattern rejects both, so proposing one would hand the user an
    // error they did not type.
    expect(suggestCustomProviderId("!!openai!!")).toBe("openai");
  });
});

describe("custom provider model ids", () => {
  it("accepts either separator and drops the noise", () => {
    expect(
      parseCustomProviderModels(" gpt-4o-mini,\n\n llama-3.1-70b , "),
    ).toEqual(["gpt-4o-mini", "llama-3.1-70b"]);
  });

  it("keeps the user's order while collapsing duplicates", () => {
    // Order is meaning here - the first entry is what a picker lands on - so
    // this deliberately does not sort.
    expect(parseCustomProviderModels("b\na\nb")).toEqual(["b", "a"]);
  });
});

describe("custom provider draft validation", () => {
  it("passes a draft the wire would accept", () => {
    expect(
      hasCustomProviderDraftError(
        validateCustomProviderDraft(draft({}), CREATE),
      ),
    ).toBe(false);
  });

  it("rejects the paste people actually make", () => {
    // A scheme-less host is what gets pasted, `z.url()` rejects it at the
    // schema boundary, and catching it here turns a provider that silently
    // never works into a message beside the field.
    expect(
      validateCustomProviderDraft(
        draft({ baseUrl: "api.example.test/v1" }),
        CREATE,
      ).baseUrl,
    ).toBe("Enter a full URL, including https://.");
  });

  it("allows http for a local gateway", () => {
    // Refusing it would block the most common reason to declare a custom
    // provider at all.
    expect(
      validateCustomProviderDraft(
        draft({ baseUrl: "http://localhost:11434/v1" }),
        CREATE,
      ).baseUrl,
    ).toBeNull();
  });

  it("requires at least one model id", () => {
    // Upstream's own constraint, not tidiness: `T(id)` needs a non-empty model
    // map, so a custom provider declared with none would not be recognized as
    // custom by the predicate that decides whether the row is editable.
    expect(
      validateCustomProviderDraft(draft({ models: " \n " }), CREATE).models,
    ).toBe("Enter at least one model id.");
  });

  it("refuses to shadow a provider that already exists", () => {
    expect(
      validateCustomProviderDraft(draft({ id: "openai" }), {
        takenIds: ["openai"],
        existing: false,
      }).id,
    ).toBe("A provider with this id already exists.");
  });

  it("reports every bad field at once", () => {
    // Four short fields in one dialog: reporting them one at a time turns a
    // single fix into four submit-and-read rounds.
    const errors = validateCustomProviderDraft(
      { id: "Not An Id", name: "  ", baseUrl: "nope", models: "" },
      CREATE,
    );
    expect(errors.id).not.toBeNull();
    expect(errors.name).not.toBeNull();
    expect(errors.baseUrl).not.toBeNull();
    expect(errors.models).not.toBeNull();
  });
});

describe("custom provider values", () => {
  it("produces the wire shape, field for field", () => {
    expect(
      customProviderValues(
        draft({ id: " my-gateway ", models: "a\nb", name: " My gateway " }),
        CREATE,
      ),
    ).toEqual({
      modelProviderId: "my-gateway",
      name: "My gateway",
      baseUrl: "https://api.example.test/v1",
      modelIds: ["a", "b"],
    });
  });

  it("answers null rather than a half-built payload", () => {
    expect(customProviderValues(draft({ models: "" }), CREATE)).toBeNull();
  });
});

describe("declared values off an entry", () => {
  it("carries what the host reported, unvalidated", () => {
    // The READ side of the wire is looser than the write side on purpose:
    // `opencode.json` is hand-editable. Refusing to carry a malformed value
    // here would leave Edit - the only surface that can fix it - with nothing
    // to open.
    expect(
      customProviderValuesOf({
        id: "my-gateway",
        name: "My gateway",
        custom: { baseUrl: "api.example.test/v1", modelIds: ["a"] },
      }),
    ).toEqual({
      modelProviderId: "my-gateway",
      name: "My gateway",
      baseUrl: "api.example.test/v1",
      modelIds: ["a"],
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
    modelProviderId: "my-gateway",
    name: "My gateway",
    baseUrl: "https://api.example.test/v1",
    modelIds: ["a"],
  };

  it("allows a declaration the write side would accept", () => {
    expect(canReenableCustomProvider(values)).toBe(true);
  });

  it("refuses one the write side would reject", () => {
    // Sending it back would report a failure the user never had a chance to
    // fix; that row gets Edit instead.
    expect(
      canReenableCustomProvider({ ...values, baseUrl: "api.example.test/v1" }),
    ).toBe(false);
    expect(canReenableCustomProvider({ ...values, modelIds: [] })).toBe(false);
  });

  it("allows an id we would never have MINTED but the host accepts", () => {
    // A hand-written `my_gateway` is legal on the wire and legal to the host,
    // which refuses only `__proto__`. Judging it by the slug rules locked the
    // row permanently: no re-enable, and an Edit whose id field is disabled -
    // so the very thing being complained about could not be changed.
    expect(
      canReenableCustomProvider({ ...values, modelProviderId: "my_gateway" }),
    ).toBe(true);
    expect(
      canReenableCustomProvider({ ...values, modelProviderId: "My.Gateway" }),
    ).toBe(true);
  });

  it("still refuses the one id no path may send", () => {
    expect(
      canReenableCustomProvider({ ...values, modelProviderId: "__proto__" }),
    ).toBe(false);
  });
});

describe("id policy by scope", () => {
  it("imposes the slug shape only on an id being MINTED", () => {
    // Our house style for ids we propose; not a judgement we get to make about
    // one the user already wrote into their own config file.
    expect(
      validateCustomProviderDraft(draft({ id: "my_gateway" }), CREATE).id,
    ).toBe("Use lowercase letters, numbers and dashes.");
    expect(
      validateCustomProviderDraft(draft({ id: "my_gateway" }), EXISTING).id,
    ).toBeNull();
  });

  it("refuses __proto__ under BOTH policies", () => {
    // A hazard rather than a house style, so it holds however the id got here.
    // The host answers it with `invalid_input`; this puts the message on the
    // field.
    // The hazard is checked FIRST, so both policies answer with it rather than
    // one of them calling it a style violation.
    expect(
      validateCustomProviderDraft(draft({ id: "__proto__" }), CREATE).id,
    ).toBe("That id isn't allowed.");
    expect(
      validateCustomProviderDraft(draft({ id: "__proto__" }), EXISTING).id,
    ).toBe("That id isn't allowed.");
  });

  it("checks collisions only when minting", () => {
    // An existing row keeps the id it already has; "taken" by itself is not a
    // reason to refuse its own edit.
    expect(
      validateCustomProviderDraft(draft({ id: "openai" }), {
        takenIds: ["openai"],
        existing: true,
      }).id,
    ).toBeNull();
  });

  it("still requires an id at all", () => {
    expect(validateCustomProviderDraft(draft({ id: "  " }), EXISTING).id).toBe(
      "Enter an id.",
    );
  });
});
