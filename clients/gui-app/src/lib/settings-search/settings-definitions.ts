/**
 * Docs: see `src/components/settings/SETTINGS.md` § Search.
 *
 * The one description of a searchable setting, read by BOTH the surface that
 * renders it and the index that finds it.
 *
 * A settings section is a plain keyed object handed to `defineSettingsSection`,
 * which enumerates it: every member becomes a definition the panel renders
 * (`collection.definitions.<key>`), and the entry-owning ones — plus the page —
 * become the collection's search entries (`collection.entries`). There is no
 * second value to keep in step with the first: a row cannot render without the
 * definition that indexes it, because `SettingsRow` / `SettingsGroup` take
 * nothing else for their content.
 *
 * React-free and leaf: a `*.definitions.ts` collection may import this module
 * and the availability predicates, never the assembled index or its consumer.
 */
import {
  alwaysAvailable,
  type SettingsAvailabilityContext,
} from "@/lib/settings/settings-availability";
import type { SettingsSectionId } from "@/lib/settings-sections";

/** Whether an element exists in the given shell. */
export type SettingsAvailability = (
  context: SettingsAvailabilityContext,
) => boolean;

/**
 * What a search hit IS, which is also what clicking it can promise.
 *
 * - `section` — a whole settings page. Lands at the top of it.
 * - `group` — a titled card inside a page ("Fonts and text", "Running agents"),
 *   or a named region of a bespoke page that has no card.
 * - `setting` — one row, the thing a user actually came to change.
 *
 * The kind is not decoration: it breaks ties between equal-scoring hits (a row
 * beats the page containing it, because the row is the more specific answer to
 * the same words) and it is what the result list badges.
 */
export type SettingsSearchEntryKind = "section" | "group" | "setting";

export interface SettingsSearchEntry {
  /** The page this lives on — where a click navigates. */
  readonly section: SettingsSectionId;
  /**
   * The `data-settings-anchor` token on the element to scroll to and flash, or
   * `null` to land at the top of the page.
   *
   * Unique across the WHOLE index (asserted by the index test), so a lookup
   * never needs the section to disambiguate it.
   *
   * `null` is a real answer, not a gap: a page whose content only exists once
   * a host answers an RPC has nothing stable to point at on a cold open, and a
   * link to an element that is not there yet is worse than a link to the page.
   */
  readonly anchor: string | null;
  readonly kind: SettingsSearchEntryKind;
  /**
   * Whether this entry's element exists in the given shell — the SAME
   * predicate the panel calls to decide whether to render it, composed with its
   * group's for a row (see `lib/settings/settings-availability.ts`).
   */
  readonly availableWhen: SettingsAvailability;
  /** The text the surface renders, because the surface renders it from here. */
  readonly label: string;
  /** The static description where there is one — searched at low weight. */
  readonly description: string | null;
  /** The group this sits under, for the result's breadcrumb. */
  readonly group: string | null;
  /**
   * The words a user reaches for that the label does NOT contain — its own,
   * followed by every contributor's label and keywords.
   */
  readonly keywords: ReadonlyArray<string>;
}

/**
 * How a member reaches search. Exactly one of:
 *
 * - `{ anchor }` — its OWN entry. A string is the `data-settings-anchor` token
 *   the primitive writes; `null` is a region of a bespoke page with nothing
 *   stable to point at, and lands at the top of the page.
 * - `{ contributesTo }` — NO entry. Its label and keywords fold into the
 *   target's document instead: an entry-owning member of the same section, or
 *   `"page"`. For a member whose element no shell can promise — gated on data,
 *   a mode, the selected host or the host runtime — because a result must land
 *   somewhere.
 */
export type SettingsSearchPlacement<Target extends string> =
  | { readonly anchor: string | null }
  | { readonly contributesTo: Target | "page" };

/** A section's page entry. Every collection has exactly one. */
export interface SettingsPageInput {
  readonly label: string;
  readonly description: string;
  readonly keywords: ReadonlyArray<string>;
}

export interface SettingsGroupInput<Target extends string> {
  readonly kind: "group";
  readonly search: SettingsSearchPlacement<Target>;
  readonly label: string;
  /** Searchable copy only; a group renders no description. */
  readonly description: string | null;
  /**
   * The group segment of this entry's breadcrumb. `null` for a rendered card;
   * a bespoke page's region groups, which sit inside no rendered group, name
   * the region they belong to ("Providers").
   */
  readonly breadcrumb: string | null;
  readonly availableWhen: SettingsAvailability;
  readonly keywords: ReadonlyArray<string>;
}

export interface SettingsRowInput<Group extends string, Target extends string> {
  readonly kind: "row";
  /** The key of the group-kind member it renders inside, or `null`. */
  readonly group: Group | null;
  readonly search: SettingsSearchPlacement<Target>;
  readonly label: string;
  /**
   * The static description — both what the row shows (unless a call site
   * passes a `status`) and the searchable copy. `null` when the row has no
   * fixed sentence: its live one goes in `status`.
   */
  readonly description: string | null;
  /** The row's own gate; its group's is composed in. */
  readonly availableWhen: SettingsAvailability;
  readonly keywords: ReadonlyArray<string>;
}

type SettingsMemberInput =
  | SettingsGroupInput<string>
  | SettingsRowInput<string, string>;

/** The loose shape a section's input is inferred from. */
export interface SettingsSectionInputShape {
  readonly page: SettingsPageInput;
  readonly [key: string]: SettingsPageInput | SettingsMemberInput;
}

type MemberKey<Input> = Exclude<keyof Input, "page"> & string;

type GroupKey<Input> = {
  [Key in MemberKey<Input>]: Input[Key] extends { readonly kind: "group" }
    ? Key
    : never;
}[MemberKey<Input>];

/**
 * A member whose `search` names BOTH placements. Structurally it satisfies the
 * `{ anchor }` arm and the `{ contributesTo }` arm at once — a union does not
 * reject a property that another arm declares — so it is caught by name here.
 */
interface HybridPlacement {
  readonly search: {
    readonly anchor: unknown;
    readonly contributesTo: unknown;
  };
}

/**
 * What a hybrid's `search` is checked against. An object with a required
 * property no real placement has, so the compiler reports it as missing and
 * prints the reason on the offending member.
 *
 * This rejects the INFERRED hybrid — the literal or spread a person writes.
 * A value annotated with a widened placement type can carry both fields
 * past the conditional, so the index test's raw-input invariant is the check
 * that covers every shape; this one exists to fail at the keyboard.
 */
interface ExclusivePlacementError {
  readonly placementError: "search takes exactly one of { anchor } or { contributesTo }";
}

type EntryOwnerKey<Input> = {
  [Key in MemberKey<Input>]: Input[Key] extends HybridPlacement
    ? never
    : Input[Key] extends {
          readonly search: { readonly anchor: string | null };
        }
      ? Key
      : never;
}[MemberKey<Input>];

/**
 * The inferred input re-checked against its own keys: a row's `group` must
 * name a group-kind member, every `contributesTo` an entry-owning member or
 * `"page"` — which rules out a dangling key, the member itself, and another
 * contributor — and a `search` must name one placement, not both. Each is a
 * compile error on the offending member.
 */
type CheckedSectionInput<Input> = {
  readonly [Key in keyof Input]: Key extends "page"
    ? SettingsPageInput
    : Input[Key] extends HybridPlacement
      ? { readonly search: ExclusivePlacementError }
      : Input[Key] extends { readonly kind: "group" }
        ? SettingsGroupInput<EntryOwnerKey<Input>>
        : SettingsRowInput<GroupKey<Input>, EntryOwnerKey<Input>>;
};

/** A placement once the section is enumerated, target keys erased. */
export type SettingsDefinitionSearch =
  | { readonly anchor: string | null }
  | { readonly contributesTo: string };

interface SettingsDefinitionBase {
  readonly section: SettingsSectionId;
  /** Its key in the section input. */
  readonly key: string;
  readonly search: SettingsDefinitionSearch;
  /**
   * The `data-settings-anchor` token its element carries: `search.anchor` for
   * an entry owner, `null` for a contributor.
   */
  readonly anchor: string | null;
  readonly label: string;
  readonly description: string | null;
  readonly keywords: ReadonlyArray<string>;
  /** Effective availability — for a row, its own AND its group's. */
  readonly availableWhen: SettingsAvailability;
}

export interface SettingsRowDefinition extends SettingsDefinitionBase {
  readonly kind: "row";
  /** The key of its group, or `null`. */
  readonly group: string | null;
}

export interface SettingsGroupDefinition extends SettingsDefinitionBase {
  readonly kind: "group";
  readonly breadcrumb: string | null;
}

export type SettingsDefinition =
  | SettingsRowDefinition
  | SettingsGroupDefinition;

type SettingsDefinitionsOf<Input> = {
  readonly [Key in MemberKey<Input>]: Input[Key] extends {
    readonly kind: "group";
  }
    ? SettingsGroupDefinition
    : SettingsRowDefinition;
};

/** A collection with its member keys erased — what the index assembles. */
export interface AnySettingsSectionCollection {
  readonly section: SettingsSectionId;
  /** The plain input, kept so a test can check the enumeration against it. */
  readonly input: SettingsSectionInputShape;
  readonly page: SettingsPageInput;
  readonly definitions: Readonly<Record<string, SettingsDefinition>>;
  /** The page entry, then every entry-owning member in input order. */
  readonly entries: ReadonlyArray<SettingsSearchEntry>;
}

export interface SettingsSectionCollection<
  Input,
> extends AnySettingsSectionCollection {
  readonly definitions: SettingsDefinitionsOf<Input>;
}

/**
 * Enumerate one section's plain keyed input into its definitions and its
 * search entries.
 *
 * Every output is created here, from the input, in one pass over its keys, so
 * nothing a panel renders can be missing from what the index reads. Folding is
 * deterministic: a target's keywords are its own, then each contributor's label
 * and keywords in input order, with case-insensitive duplicates dropped.
 */
export function defineSettingsSection<
  const Input extends SettingsSectionInputShape,
>(
  section: SettingsSectionId,
  input: Input & CheckedSectionInput<Input>,
): SettingsSectionCollection<Input> {
  const members = new Map<string, SettingsMemberInput>();
  for (const [key, value] of Object.entries(input)) {
    if (isMemberInput(value)) members.set(key, value);
  }
  const byKey = new Map<string, SettingsDefinition>();
  for (const [key, member] of members) {
    byKey.set(key, defineMember(section, key, member, members));
  }

  const contributions = new Map<string, Array<string>>();
  for (const definition of byKey.values()) {
    if (!("contributesTo" in definition.search)) continue;
    const target = definition.search.contributesTo;
    const words = contributions.get(target) ?? [];
    words.push(definition.label, ...definition.keywords);
    contributions.set(target, words);
  }

  const page = input.page;
  const entries: Array<SettingsSearchEntry> = [
    {
      section,
      anchor: null,
      kind: "section",
      availableWhen: alwaysAvailable,
      label: page.label,
      description: page.description,
      group: null,
      keywords: foldKeywords(page.keywords, contributions.get("page") ?? []),
    },
  ];
  for (const definition of byKey.values()) {
    if (!("anchor" in definition.search)) continue;
    entries.push({
      section,
      anchor: definition.search.anchor,
      kind: definition.kind === "row" ? "setting" : "group",
      availableWhen: definition.availableWhen,
      label: definition.label,
      description: definition.description,
      group: breadcrumbFor(definition, byKey),
      keywords: foldKeywords(
        definition.keywords,
        contributions.get(definition.key) ?? [],
      ),
    });
  }

  const definitions: Readonly<Record<string, SettingsDefinition>> =
    Object.fromEntries(byKey);
  return {
    section,
    input,
    page,
    // Filled by enumerating `input`'s own member keys, each with the kind that
    // key declares — exactly the per-key shape this names.
    definitions: definitions as SettingsDefinitionsOf<Input>,
    entries,
  };
}

/** Every collection's entries, in assembly order. */
export function assembleSettingsSearchEntries(
  collections: ReadonlyArray<AnySettingsSectionCollection>,
): ReadonlyArray<SettingsSearchEntry> {
  return collections.flatMap((collection) => collection.entries);
}

function isMemberInput(
  value: SettingsPageInput | SettingsMemberInput,
): value is SettingsMemberInput {
  return "kind" in value;
}

function defineMember(
  section: SettingsSectionId,
  key: string,
  member: SettingsMemberInput,
  members: ReadonlyMap<string, SettingsMemberInput>,
): SettingsDefinition {
  const search: SettingsDefinitionSearch = member.search;
  const anchor = "anchor" in search ? search.anchor : null;
  if (member.kind === "group") {
    return {
      kind: "group",
      section,
      key,
      search,
      anchor,
      label: member.label,
      description: member.description,
      breadcrumb: member.breadcrumb,
      keywords: member.keywords,
      availableWhen: member.availableWhen,
    };
  }
  return {
    kind: "row",
    section,
    key,
    group: member.group,
    search,
    anchor,
    label: member.label,
    description: member.description,
    keywords: member.keywords,
    availableWhen: rowAvailability(member, members),
  };
}

/**
 * Containment composes: a row exists only where its group does. A
 * contribution target is not a container, so contributing never touches it.
 */
function rowAvailability(
  row: SettingsRowInput<string, string>,
  members: ReadonlyMap<string, SettingsMemberInput>,
): SettingsAvailability {
  if (row.group === null) return row.availableWhen;
  const group = members.get(row.group);
  if (group?.kind !== "group") {
    throw new Error(`settings row group "${row.group}" is not a group`);
  }
  const own = row.availableWhen;
  const container = group.availableWhen;
  return (context) => container(context) && own(context);
}

function breadcrumbFor(
  definition: SettingsDefinition,
  definitions: ReadonlyMap<string, SettingsDefinition>,
): string | null {
  if (definition.kind === "group") return definition.breadcrumb;
  if (definition.group === null) return null;
  return definitions.get(definition.group)?.label ?? null;
}

function foldKeywords(
  own: ReadonlyArray<string>,
  contributed: ReadonlyArray<string>,
): ReadonlyArray<string> {
  const seen = new Set<string>();
  const folded: Array<string> = [];
  for (const word of [...own, ...contributed]) {
    const normalized = word.toLowerCase();
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    folded.push(word);
  }
  return folded;
}
