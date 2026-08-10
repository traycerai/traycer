/**
 * The form model behind "Add custom provider" - an OpenAI-compatible endpoint
 * the user declares themselves (upstream writes it into the provider's config
 * file as `npm: "@ai-sdk/openai-compatible"` plus a model map).
 *
 * Pure, and separate from the dialog, for the usual two reasons: it is the part
 * worth testing directly, and a component module that exports non-components
 * loses fast refresh for the whole file.
 *
 * The npm package is NOT a field. Upstream fixes it, and a custom provider that
 * names a different adapter is not a thing this flow can honestly create - so
 * offering the box would be offering a way to write a config the host will not
 * run.
 */

export type CustomProviderDraft = {
  readonly id: string;
  readonly name: string;
  readonly baseUrl: string;
  /** Raw text as typed - one id per line, or comma-separated. */
  readonly models: string;
};

/** The draft's editable fields, as a key the dialog can track per field. */
export type CustomProviderField = keyof CustomProviderDraft;

export type CustomProviderDraftErrors = {
  readonly id: string | null;
  readonly name: string | null;
  readonly baseUrl: string | null;
  readonly models: string | null;
};

/**
 * What a validated draft becomes on the wire - the protocol's shared
 * `createCustom` / `updateCustom` shape, field for field, so the submit path
 * spreads it instead of re-mapping four names.
 */
export type CustomProviderValues = {
  readonly modelProviderId: string;
  readonly name: string;
  readonly baseUrl: string;
  readonly modelIds: readonly string[];
};

export const EMPTY_CUSTOM_PROVIDER_DRAFT: CustomProviderDraft = {
  id: "",
  name: "",
  baseUrl: "",
  models: "",
};

/**
 * What a declared custom row is currently declared WITH, ready to prefill the
 * edit form - or null for a row that is not a declared custom provider.
 *
 * Unvalidated on purpose. The read side of the wire is deliberately looser than
 * the write side: `opencode.json` is hand-editable, so a declared base URL may
 * be malformed and a model list may be junk. Refusing to carry those values
 * here would leave Edit - the only surface that can fix them - with nothing to
 * open, which is precisely the row that needs it.
 */
export function customProviderValuesOf(entry: {
  readonly id: string;
  readonly name: string;
  readonly custom: {
    readonly baseUrl: string;
    readonly modelIds: readonly string[];
  } | null;
}): CustomProviderValues | null {
  if (entry.custom === null) return null;
  return {
    modelProviderId: entry.id,
    name: entry.name,
    baseUrl: entry.custom.baseUrl,
    modelIds: entry.custom.modelIds,
  };
}

/**
 * Whether a declared row could be re-enabled AS IS - `updateCustom` with its
 * own values, no typing.
 *
 * False for a declaration the write side would reject (the hand-edited
 * `opencode.json` case). Offering a one-click re-enable there would send the
 * user's own broken values back and report a failure they had no chance to fix;
 * the row offers Edit instead, which opens the form on exactly what is wrong.
 */
export function canReenableCustomProvider(
  values: CustomProviderValues,
): boolean {
  return (
    customProviderValues(
      {
        id: values.modelProviderId,
        name: values.name,
        baseUrl: values.baseUrl,
        models: values.modelIds.join("\n"),
      },
      // An EXISTING declaration, so its id is judged as one: a hand-written
      // `my_gateway` is legal on the wire and legal to the host, and refusing
      // to re-enable it would strand the row behind a rule that only ever
      // governed ids we mint.
      { takenIds: [], existing: true },
    ) !== null
  );
}

/**
 * A provider id is a KEY in the provider's config object and an id the rest of
 * the catalog is addressed by, so it gets the conservative shape every such id
 * in that file already has: lowercase, digits, dashes.
 */
const PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

/**
 * The id we propose from a typed name, so the common case never has to think
 * about a second field.
 *
 * Proposed, not imposed: the field stays editable, because a user pointing at
 * an internal gateway may need the id to match what their own tooling already
 * calls it. Once they touch it we stop tracking the name - re-deriving would
 * silently overwrite what they typed on the next keystroke.
 */
export function suggestCustomProviderId(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Model ids as the config wants them: one per line or comma-separated, trimmed,
 * blank runs dropped, duplicates collapsed.
 *
 * Order is preserved rather than sorted - the first entry is what a picker
 * lands on, and the user typed them in the order they care about.
 */
export function parseCustomProviderModels(models: string): readonly string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of models.split(/[\n,]/)) {
    const id = raw.trim();
    if (id.length === 0 || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/**
 * The one id no surface may send, on any path.
 *
 * The host answers it with `invalid_input`, and it is refused here so the
 * message lands on the field. Kept separate from the slug pattern because it is
 * a different KIND of rule: the pattern is a house style for ids we mint, this
 * is a hazard that holds however the id got here.
 */
const FORBIDDEN_PROVIDER_ID = "__proto__";

/**
 * Two id policies, because there are two questions.
 *
 * MINTING an id is a house-style decision, and the slug pattern is ours to
 * impose: it is what every id in that config file already looks like, and we
 * are the ones proposing it.
 *
 * An EXISTING id is not ours to judge. The user may have hand-written
 * `my_gateway` into `opencode.json` - underscores are legal on the wire and
 * legal to the host, which refuses only `__proto__` - and applying the minting
 * pattern to it locked the row permanently: no re-enable (the values "fail
 * validation"), and an Edit whose id field is disabled, so the thing being
 * complained about could not even be changed. Judging a value by the rule that
 * would have created it is the bug; these are separate rules now.
 */
function idError(
  id: string,
  args: { readonly takenIds: readonly string[]; readonly existing: boolean },
): string | null {
  if (id.length === 0) return "Enter an id.";
  if (id === FORBIDDEN_PROVIDER_ID) return "That id isn't allowed.";
  if (args.existing) return null;
  if (!PROVIDER_ID_PATTERN.test(id)) {
    return "Use lowercase letters, numbers and dashes.";
  }
  if (args.takenIds.includes(id)) {
    return "A provider with this id already exists.";
  }
  return null;
}

function modelsError(modelIds: readonly string[]): string | null {
  if (modelIds.length === 0) return "Enter at least one model id.";
  if (modelIds.some((modelId) => /\s/.test(modelId))) {
    return "Model ids can't contain spaces.";
  }
  return null;
}

function baseUrlError(baseUrl: string): string | null {
  const trimmed = baseUrl.trim();
  if (trimmed.length === 0) return "Enter the endpoint's base URL.";
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return "Enter a full URL, including https://.";
  }
  // http is allowed on purpose: these endpoints are routinely a local or
  // in-cluster gateway (`http://localhost:11434/v1`), and refusing it would
  // block the most common reason to declare a custom provider at all.
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return "Use an http:// or https:// URL.";
  }
  return null;
}

/**
 * Field-level errors for a draft, all fields at once.
 *
 * All at once rather than first-failure: this is four short fields in one
 * dialog, and reporting them one at a time turns a single fix into four
 * submit-and-read rounds.
 *
 * `scope.takenIds` are the ids already in the catalog. A collision is a real
 * failure and a confusing one to debug later - upstream would happily let the
 * new block shadow an existing provider, and the row that "did nothing" is the
 * one the user is not looking at.
 *
 * `scope.existing` says the id came off a row rather than out of this form. It
 * changes which id rule applies - see {@link idError} - and it is the caller's
 * to state, because only the caller knows whether this draft is declaring a
 * provider or editing one.
 */
export type CustomProviderIdScope = {
  readonly takenIds: readonly string[];
  readonly existing: boolean;
};

export function validateCustomProviderDraft(
  draft: CustomProviderDraft,
  scope: CustomProviderIdScope,
): CustomProviderDraftErrors {
  const id = draft.id.trim();
  const name = draft.name.trim();
  const modelIds = parseCustomProviderModels(draft.models);
  return {
    id: idError(id, scope),
    name: name.length === 0 ? "Enter a name." : null,
    baseUrl: baseUrlError(draft.baseUrl),
    models: modelsError(modelIds),
  };
}

export function hasCustomProviderDraftError(
  errors: CustomProviderDraftErrors,
): boolean {
  return (
    errors.id !== null ||
    errors.name !== null ||
    errors.baseUrl !== null ||
    errors.models !== null
  );
}

/**
 * The validated draft as values, or null when it does not validate.
 *
 * Re-validates rather than trusting the caller's last render: the submit path
 * is the only place the values are read, so it is the only place worth being
 * sure at.
 */
export function customProviderValues(
  draft: CustomProviderDraft,
  scope: CustomProviderIdScope,
): CustomProviderValues | null {
  if (hasCustomProviderDraftError(validateCustomProviderDraft(draft, scope))) {
    return null;
  }
  return {
    modelProviderId: draft.id.trim(),
    name: draft.name.trim(),
    baseUrl: draft.baseUrl.trim(),
    modelIds: parseCustomProviderModels(draft.models),
  };
}
