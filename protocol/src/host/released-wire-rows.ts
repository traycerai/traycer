/**
 * The fields released clients still parse, and the constants this tree fills
 * them with.
 *
 * `refactor(protocol): no secret enters a sandbox as plain text` removed the
 * secret's mode, its export policy, the held-value plane and the
 * process-scoped harness plane. Removing them from the WIRE as well broke
 * every released peer: `cli-v1.5.2` and `cli-v1.5.3` declare `mode` and
 * `state` as REQUIRED on the secret row, and their getting-started checklist
 * calls `environment.secrets.list` as soon as a host advertises the method,
 * so a released desktop meeting a host built from that tree failed to parse
 * on a landing surface. `protocol-compat.yml` caught it on the merge, which
 * is the first run a team pull request into `main` gets.
 *
 * A new MINOR cannot carry a removal: within one major the newer side serves
 * an older minor directly and relies on the line being additive
 * (`compatibility-checker.ts`, `canBridgeFromMySide`), so an older minor's
 * required field must still be there. A new MAJOR with a downgrade bridge
 * could carry it, and buys nothing a constant does not: nobody reads these
 * fields any more.
 *
 * So the released versions keep their field NAMES, and this module holds the
 * only values this tree ever writes into them. They describe the one world
 * that is left - every secret is brokered, every live row is live - so they
 * are not a default standing in for an unknown, and no column, route or
 * plane comes back with them. A released peer that SENDS a removed plane
 * (`mode: "exposed"`, an export policy, a `secret` or `variable` choice) is
 * refused at the handler, which is the rule the removal was made under: a
 * case the broker cannot serve is refused, never served as plain text.
 *
 * Raising `protocol/scripts/compat/support-floor.json` past `1.5.3` does NOT
 * free these fields. The restored versions are this tree's own versions too,
 * so every client built from here declares them required exactly as
 * `cli-v1.5.2` does; moving the floor past the two releases that started this
 * only drops the oldest peers, never the requirement. Two things can end this
 * module, and nothing else:
 *
 *  - a new method MAJOR that omits the fields, with a downgrade bridge filling
 *    them for every older major still supported; or
 *  - proof that no supported peer parses the restored line any more - every
 *    version in the protected set at or above a major that omits them - at
 *    which point the restored minors and this module leave together.
 */

/**
 * The secret row's retired fields, for every released
 * `environment.secrets.list` and the `created` arm of
 * `environment.secrets.create`.
 */
export const RETIRED_SECRET_ROW_FIELDS = {
  mode: "brokered",
  state: "live",
} as const;

/**
 * `environment.secrets.list@1.2`'s retired row field. No secret is bound to a
 * name in one provider's env any more, so the list is empty rather than
 * absent: `@1.2` declares the key.
 */
export const RETIRED_PROVIDER_VARIABLES: readonly {
  readonly providerId: string;
  readonly name: string;
}[] = [];

/**
 * What a client of this tree sends on `environment.secrets.create@1.0` and
 * `@1.1`, whose released request declares both. Kept as the released schema
 * has them rather than made optional, because changing a released version's
 * shape is the break this module exists to undo.
 */
export const RETIRED_SECRET_CREATE_FIELDS = {
  mode: "brokered",
  exportPolicy: null,
} as const;

/**
 * `environment.move.plan`'s retired row group. A value that reads like a
 * credential is listed under `staysOnThisComputer` now, and the move offers
 * no choice for it, so this group is empty on every plan.
 */
export const RETIRED_LOOKS_LIKE_A_KEY_ROWS: readonly never[] = [];

/**
 * `environment.move.plan@1.1`'s other retired row group: rows that look like
 * a key whose name Personal already holds as a secret. Retired with
 * `looksLikeAKey` and empty for the same reason. The released schema declares
 * it `.default([])`, so unlike `looksLikeAKey` a host that omits the key is
 * still parsed; this constant is what the `@1.0`→`@1.1` bridge fills, so the
 * two groups read the same way at every call site.
 */
export const RETIRED_SAME_NAME_IN_PERSONAL_ROWS: readonly never[] = [];
