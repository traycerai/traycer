import { describe, expect, it } from "vitest";
import {
  customProviderValues,
  hasCustomProviderDraftError,
  parseCustomProviderModels,
  suggestCustomProviderId,
  validateCustomProviderDraft,
  type CustomProviderDraft,
} from "@/components/settings/panels/model-provider-custom-draft";

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
      hasCustomProviderDraftError(validateCustomProviderDraft(draft({}), [])),
    ).toBe(false);
  });

  it("rejects the paste people actually make", () => {
    // A scheme-less host is what gets pasted, `z.url()` rejects it at the
    // schema boundary, and catching it here turns a provider that silently
    // never works into a message beside the field.
    expect(
      validateCustomProviderDraft(draft({ baseUrl: "api.example.test/v1" }), [])
        .baseUrl,
    ).toBe("Enter a full URL, including https://.");
  });

  it("allows http for a local gateway", () => {
    // Refusing it would block the most common reason to declare a custom
    // provider at all.
    expect(
      validateCustomProviderDraft(
        draft({ baseUrl: "http://localhost:11434/v1" }),
        [],
      ).baseUrl,
    ).toBeNull();
  });

  it("requires at least one model id", () => {
    // Upstream's own constraint, not tidiness: `T(id)` needs a non-empty model
    // map, so a custom provider declared with none would not be recognized as
    // custom by the predicate that decides whether the row is editable.
    expect(
      validateCustomProviderDraft(draft({ models: " \n " }), []).models,
    ).toBe("Enter at least one model id.");
  });

  it("refuses to shadow a provider that already exists", () => {
    expect(
      validateCustomProviderDraft(draft({ id: "openai" }), ["openai"]).id,
    ).toBe("A provider with this id already exists.");
  });

  it("reports every bad field at once", () => {
    // Four short fields in one dialog: reporting them one at a time turns a
    // single fix into four submit-and-read rounds.
    const errors = validateCustomProviderDraft(
      { id: "Not An Id", name: "  ", baseUrl: "nope", models: "" },
      [],
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
        [],
      ),
    ).toEqual({
      modelProviderId: "my-gateway",
      name: "My gateway",
      baseUrl: "https://api.example.test/v1",
      modelIds: ["a", "b"],
    });
  });

  it("answers null rather than a half-built payload", () => {
    expect(customProviderValues(draft({ models: "" }), [])).toBeNull();
  });
});
