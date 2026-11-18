/**
 * Barrel for typed domain errors thrown by local mutations. Keep each
 * error in its own module so call-sites importing a single class don't
 * drag in every error definition, and add new errors as sibling files
 * with an entry below.
 */
export { ReparentCycleError } from "./reparent-cycle-error";
export { CrossFamilyParentError } from "./cross-family-parent-error";
export { MissingNodeError } from "./missing-node-error";
