import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import ts from "typescript";
import { z } from "zod";
import { BROWSER_VIEWPORT_MAX_PIXELS } from "../../host/browser/viewport";
import {
  PROVIDER_AUTH_STATUS_SCHEMA,
  PROVIDER_AUTH_STATUS_SCHEMA_V20,
} from "../../host/provider-schemas";
import {
  hostStatusV13,
  hostStatusV14,
  hostStatusV15,
} from "../../host/status/contracts";
import {
  worktreeListAllForHostRequestSchemaV11,
  worktreeListAllForHostRequestSchemaV12,
} from "../../host/worktree-schemas";
import {
  formatHit,
  gitListedFiles,
  hitsOf,
  allowListMismatches,
  isUnanalysedHit,
  scanThunkRules,
  unanalysedCountsOf,
  unanalysedLabelsOf,
  UNANALYSED_KIND,
  type ThunkScanResult,
} from "./lazy-schema-thunk-rules-scanner";

/**
 * AST scan of every `lazySchema(` thunk in protocol/src and clients/. The
 * scanner is `lazy-schema-thunk-rules-scanner.ts`, shared with the host twin
 * (`traycer-host/src/__tests__/lazy-schema-thunk-rules-scan.test.ts`); every
 * planted control lives here, once.
 *
 * R1 outermost `.describe(`/`.meta(`/`.register(` of a returned expression
 * R2 outermost `z.instanceof(`
 * R3 outermost `z.json(`
 * R4 returned identifier bound to a thunk-local const that a nested function
 *    (getter / z.lazy arrow) references
 * R5 side effects while the thunk runs, interprocedural through imports, and
 *    fail-closed: what the walk cannot follow is a `U unanalysed` finding
 * R6 returned expression is an existing value the thunk does not declare
 */

const PROTOCOL_ROOT = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const TRAYCER_ROOT = path.join(PROTOCOL_ROOT, "..");
const REPO_ROOT = path.join(TRAYCER_ROOT, "..");
const PROTOCOL_SRC = path.join(PROTOCOL_ROOT, "src");
const COMMON_SRC = path.join(REPO_ROOT, "packages/common/src");

const SCAN_PREFIXES = ["protocol/src/", "clients/"] as const;

/**
 * The unanalysed calls production holds today, one entry per label, with the
 * number of source sites that carry it and the reason it is pure. The
 * production scan must produce EXACTLY these labels AND counts: a new label is
 * a call the scan cannot follow, a higher count is a further call under a
 * judged label, and a label that no longer appears is stale; each must be
 * judged. An entry's reason can also go false with its label unchanged, so
 * the "allow-list premises" tests below assert the premise itself.
 */
const ALLOWED_UNANALYSED: ReadonlyMap<
  string,
  { readonly count: number; readonly reason: string }
> = new Map([
  [
    "method-on-unknown-provenance keys.at (protocol/src/framework/versioned-record.ts)",
    {
      count: 1,
      reason:
        "getSortedNumberKeys returns Object.keys(values).map(Number).sort(..), a fresh array, and `.at(-1)` only reads it",
    },
  ],
  [
    "parse-runs-callbacks absoluteHostPathSchema.safeParse (protocol/src/host/workspace/unary-schemas.ts)",
    {
      count: 1,
      reason:
        "the schema is z.string().min(1).regex(ABSOLUTE_HOST_PATH, ..) with no refine or transform callback and a regex with no g or y flag; the call sits in a superRefine callback, so it runs at parse time, not at build (host/workspace/unary-schemas.ts:721)",
    },
  ],
  [
    "method-on-non-schema SEMVER_PATTERN.test (protocol/src/config/installation-records.ts)",
    {
      count: 1,
      reason:
        "a regex literal with no g or y flag, so `.test` keeps no lastIndex",
    },
  ],
  [
    "method-on-non-schema queueSteerNowClientFrameSchemaPreAuto.extend (protocol/src/host/agent/gui/subscribe.ts)",
    {
      count: 1,
      reason:
        "an element destructured at module scope from chatSubscribeClientFrameSchemaMiddleOptions, the tail of chatSubscribeClientFrameSchemaOptionsBeforeInterview (an array of zod schemas); `.extend` clones",
    },
  ],
  [
    "method-on-non-schema queueSettingsUpdateClientFrameSchemaPreAuto.extend (protocol/src/host/agent/gui/subscribe.ts)",
    {
      count: 1,
      reason:
        "an element destructured at module scope from chatSubscribeClientFrameSchemaMiddleOptions, the tail of chatSubscribeClientFrameSchemaOptionsBeforeInterview (an array of zod schemas); `.extend` clones",
    },
  ],
  [
    "method-on-non-schema queueSettingsRestampClientFrameSchemaPreAuto.extend (protocol/src/host/agent/gui/subscribe.ts)",
    {
      count: 1,
      reason:
        "an element destructured at module scope from chatSubscribeClientFrameSchemaMiddleOptions, the tail of chatSubscribeClientFrameSchemaOptionsBeforeInterview (an array of zod schemas); `.extend` clones",
    },
  ],
  [
    "method-on-non-schema activePermissionModeUpdateClientFrameSchemaPreAuto.extend (protocol/src/host/agent/gui/subscribe.ts)",
    {
      count: 1,
      reason:
        "an element destructured at module scope from chatSubscribeClientFrameSchemaMiddleOptions, the tail of chatSubscribeClientFrameSchemaOptionsBeforeInterview (an array of zod schemas); `.extend` clones",
    },
  ],
  [
    "method-on-non-schema chatSubscribeClientFrameSchemaOptionsBeforeInterview.extend (protocol/src/host/agent/gui/subscribe.ts)",
    {
      count: 4,
      reason: "an array of stand-ins; `.extend` clones the element",
    },
  ],
  [
    "method-on-non-schema chatSubscribeClientFrameSchemaV17ToV19Options.extend (protocol/src/host/agent/gui/subscribe.ts)",
    {
      count: 2,
      reason: "an array of stand-ins; `.extend` clones the element",
    },
  ],
  [
    "method-on-non-schema PROVIDER_AUTH_STATUS_SCHEMA.catch (protocol/src/host/provider-schemas.ts)",
    {
      count: 3,
      reason:
        "an alias of PROVIDER_AUTH_STATUS_SCHEMA_V20; `.catch` clones (the third site is the listHarnesses@9.1 freeze copy)",
    },
  ],
  [
    "method-on-non-schema PROVIDER_AUTH_STATUS_SCHEMA.optional (protocol/src/host/provider-schemas.ts)",
    {
      count: 3,
      reason:
        "an alias of PROVIDER_AUTH_STATUS_SCHEMA_V20; `.optional` clones (the third site is the listHarnesses@9.1 freeze copy)",
    },
  ],
  [
    "method-on-non-schema SHA256_HEX.test (protocol/src/config/installation-records.ts)",
    {
      count: 1,
      reason:
        "/^[a-f0-9]{64}$/ has no g or y flag, so `.test` keeps no lastIndex",
    },
  ],
  [
    "method-on-non-schema SURVIVING_CONTROL_CHARACTER.test (protocol/src/persistence/epic/role-claims.ts)",
    {
      count: 1,
      reason: "the regex has the u flag only, so `.test` keeps no lastIndex",
    },
  ],
  [
    "method-on-non-schema BROWSER_VIEWPORT_MAX_PIXELS.toLocaleString (protocol/src/host/browser/viewport.ts)",
    {
      count: 1,
      reason: "a number; `toLocaleString` reads it",
    },
  ],
  [
    "method-on-non-schema hostStatusV13.extend (protocol/src/host/status/contracts.ts)",
    {
      count: 1,
      reason: "a contract object; `.responseSchema.extend` clones",
    },
  ],
  [
    "method-on-non-schema hostStatusV14.extend (protocol/src/host/status/contracts.ts)",
    {
      count: 1,
      reason: "a contract object; `.responseSchema.extend` clones",
    },
  ],
  [
    "method-on-non-schema hostStatusV15.extend (protocol/src/host/status/contracts.ts)",
    {
      count: 1,
      reason: "a contract object; `.responseSchema.extend` clones",
    },
  ],
  [
    "method-on-non-schema worktreeListAllForHostRequestSchemaV12.extend (protocol/src/host/worktree-schemas.ts)",
    {
      count: 1,
      reason: "an alias of an earlier schema; `.extend` clones",
    },
  ],
]);

const PLANTED_HELPER_SOURCE = `export const helperLog: string[] = [];
export function pushingHelper(name: string) { helperLog.push(name); return name; }
export function pureHelper(name: string) { const local: string[] = []; local.push(name); return local; }
export class Registering { constructor(name: string) { helperLog.push(name); } }
function hiddenPush(name: string) { helperLog.push(name); return name; }
export const helperSchema = z.string();
export function declareHidden() { return () => hiddenPush("h"); }
`;

const PLANTED_PLANTED_SOURCE = `import { z } from "zod";
import { lazySchema } from "../framework/lazy-schema";
import { pushingHelper, pureHelper, Registering } from "./helper";
import * as helpers from "./helper";
let counter = 0;
let lastBuilt: unknown = undefined;
const registry = new Map<string, unknown>();
const seen = new Set<string>();
const list: string[] = [];
const holder: Record<string, unknown> = {};
// POSITIVES, one per branch: the expected kind is in the name
export const P_S1_assign = lazySchema(() => { lastBuilt = 1; return z.string(); });
export const P_S1_prop = lazySchema(() => { holder.x = 1; return z.string(); });
export const P_S1_destructure = lazySchema(() => { [lastBuilt] = [1]; return z.string(); });
export const P_S2_update = lazySchema(() => { counter++; return z.string(); });
export const P_S3_delete = lazySchema(() => { delete holder.x; return z.string(); });
export const P_S4_mapset = lazySchema(() => { registry.set("a", 1); return z.string(); });
export const P_S4_setadd = lazySchema(() => { seen.add("a"); return z.string(); });
export const P_S4_push = lazySchema(() => { list.push("a"); return z.string(); });
export const P_S4_objassign = lazySchema(() => { Object.assign(holder, { a: 1 }); return z.string(); });
export const P_Z_meta = lazySchema(() => z.string().meta({ id: "x" }));
export const P_inter_helper = lazySchema(() => z.literal(pushingHelper("a")));
export const P_inter_namespace = lazySchema(() => z.literal(helpers.pushingHelper("a")));
export const P_callback = lazySchema(() => z.enum(["a", "b"].map((v) => { list.push(v); return v; }) as ["a", "b"]));
export const P_iife = lazySchema(() => z.literal((() => { counter += 1; return 1; })()));
export const P_new = lazySchema(() => { new Registering("a"); return z.string(); });
// NEGATIVES: no effect outside the built value
export const N_local = lazySchema(() => { const xs: string[] = []; xs.push("a"); return z.enum(xs as [string]); });
export const N_fresh_chain = lazySchema(() => z.enum(Object.keys(holder).sort() as [string]));
export const N_pure_helper = lazySchema(() => z.enum(pureHelper("a") as [string]));
export const N_returned_closure = lazySchema(() => z.string().transform(() => "x"));
export const N_zod_set = lazySchema(() => z.set(z.string()));
`;

/**
 * Shapes the first version of R5 missed (B1 to B18 of the second cold
 * review), one thunk each, plus the unanalysed categories. The module scope
 * is the state the thunks reach.
 */
const PLANTED_SHAPES_SOURCE = `import { z, parse as zodParse } from "zod";
import { lazySchema } from "../framework/lazy-schema";
import { pushingHelper, declareHidden } from "./helper";
import * as helpers from "./helper";
import { ExternalBase, ExtClass, extCall } from "external-pkg";
import * as extNs from "external-pkg";
import { missingFn } from "./not-there";
let counter = 0;
let lastSeen = "";
const list: string[] = [];
const registry = new Map<string, number>();
function pushIt(id: string) { list.push(id); }
function tagPush(strings: TemplateStringsArray) { list.push(strings[0] ?? ""); return "t"; }
function withDefault(x = pushingHelper("d")) { return x; }
function withDefaultPure(x = "d") { return x; }
function makeNoter() { return (id: string) => { list.push(id); }; }
function makeRegistrar() { return { note(id: string) { list.push(id); } }; }
function pushCb(v: string) { list.push(v); }
const noteFn = makeNoter();
const put = registry.set.bind(registry);
const registrar = makeRegistrar();
const holderObj = { note(id: string) { list.push(id); return id; }, quiet(id: string) { return id; } };
const holderG = { get x() { counter++; return 1; } };
const holderQuiet = { get x() { return 1; } };
class Service { run() { counter++; } }
class SubService extends Service {}
class WithGetter { get y() { counter++; return 1; } }
class FieldInit { n = counter++; }
class FieldPure { n = 1; }
class Base { constructor() { list.push("b"); } }
class Derived extends Base {}
class DerivedExt extends ExternalBase {}
class Plain {}
class PlainDerived extends Plain {}
const svc = new Service();
const sub = new SubService();
const instG = new WithGetter();
const shapeSchema = z.object({});
const nested: string[][] = [[]];
const rec: Record<string, number> = {};
function fill(t: string[]) { t.push("a"); }
function rebindOnly(t: string[]) { t = ["a"]; return t; }
function outer(x: string[]) { fill(x); }
function setProp(t: Record<string, number>) { t.x = 1; }
function bump(t: Record<string, number>) { t.n++; }
function dropProp(t: Record<string, number>) { delete t.x; }
function assignInto(t: Record<string, number>) { Object.assign(t, { a: 1 }); }
function viaCallback(t: string[]) { ["1"].forEach(() => { t.push("a"); }); }
function methodOnParam(o: { go(): void }) { o.go(); }
function wrapSchema(s: z.ZodType) { return s.extend({}); }
function parseIt(s: z.ZodType, v: string) { return s.parse(v); }
function makeList() { return list; }
function viaLocalFn(t: string[]) { const inner = () => { t.push("a"); }; inner(); }
const [destructuredA] = [z.object({})];
// B1: a local function or arrow called by name, in the thunk and in a callback
export const P_B1_arrow = lazySchema(() => { const reg = (id: string) => { list.push(id); }; reg("a"); return z.string(); });
export const P_B1_declaration = lazySchema(() => { function reg() { counter++; } reg(); return z.string(); });
export const P_B1_closure = lazySchema(() => z.enum(["a"].map((v) => { const inner = () => { counter++; }; inner(); return v; }) as ["a"]));
// B2: a method on a non-local receiver: walked when the receiver is an object literal or class
export const P_B2_object_method = lazySchema(() => { holderObj.note("a"); return z.string(); });
export const P_B2_local_object_method = lazySchema(() => { const r = { note(id: string) { list.push(id); } }; r.note("a"); return z.string(); });
export const P_B2_class_method = lazySchema(() => { svc.run(); return z.string(); });
export const P_B2_inherited_method = lazySchema(() => { sub.run(); return z.string(); });
export const P_B2_destructured_receiver = lazySchema(() => { destructuredA.extend({}); return z.string(); });
export const P_B2_unresolvable = lazySchema(() => { registrar.note("a"); return z.string(); });
// B3: a parameter initialiser of a walked callee
export const P_B3_param_init = lazySchema(() => { withDefault(); return z.string(); });
// B4: a tagged template, the tag is the callee
export const P_B4_tagged = lazySchema(() => { tagPush\`a\`; return z.string(); });
// B5, B6: new walks field initialisers and base classes
export const P_B5_field_init = lazySchema(() => { new FieldInit(); return z.string(); });
export const P_B6_inherited_ctor = lazySchema(() => { new Derived(); return z.string(); });
export const P_B6_unresolvable_base = lazySchema(() => { new DerivedExt(); return z.string(); });
// B7: a getter on an object literal or class instance
export const P_B7_object_getter = lazySchema(() => { holderG.x; return z.string(); });
export const P_B7_class_getter = lazySchema(() => { instG.y; return z.string(); });
// B9: call, apply and bind run a function the walk cannot name
export const P_B9_call = lazySchema(() => { pushIt.call(null, "a"); return z.string(); });
export const P_B9_apply = lazySchema(() => { pushIt.apply(null, ["a"]); return z.string(); });
export const P_B9_bind = lazySchema(() => { pushIt.bind(null); return z.string(); });
// B10, B11: a callee bound to something that is not a function literal
export const P_B10_factory_result = lazySchema(() => { noteFn("a"); return z.string(); });
export const P_B11_bound = lazySchema(() => { put("a", 1); return z.string(); });
export const P_B10_local_factory_result = lazySchema(() => { const f = makeNoter(); f("a"); return z.string(); });
// B13: a for head that assigns to a binding it does not declare
export const P_B13_for_of = lazySchema(() => { for (lastSeen of ["a"]) { list.length; } return z.string(); });
export const P_B13_for_in = lazySchema(() => { for (lastSeen in { a: 1 }) { list.length; } return z.string(); });
export const P_B13_destructure = lazySchema(() => { for ([lastSeen] of [["a"]]) { list.length; } return z.string(); });
// B14: an element-access call
export const P_B14_element_call = lazySchema(() => { list["push"]("a"); return z.string(); });
// B17, B18: a prototype method through call, and Reflect.apply
export const P_B17_prototype_call = lazySchema(() => { Array.prototype.push.call(list, "a"); return z.string(); });
export const P_B18_reflect_apply = lazySchema(() => { Reflect.apply(list.push, list, ["a"]); return z.string(); });
export const P_Uf_reflect_construct = lazySchema(() => { Reflect.construct(Base, []); return z.string(); });
export const P_Uf_object_unlisted = lazySchema(() => { Object.mystery(list); return z.string(); });
// a receiver that is no identifier, a new of a local class or a function, and namespace members
export const P_Uc_this_receiver = lazySchema(function () { this.run(); return z.string(); });
export const P_B5_local_class = lazySchema(() => { class Local { constructor() { counter++; } } new Local(); return z.string(); });
export const P_new_local_function = lazySchema(() => { function Ctor() { counter++; } new Ctor(); return z.string(); });
export const P_new_module_function = lazySchema(() => { new pushIt("a"); return z.string(); });
export const P_ns_member_not_function = lazySchema(() => { helpers.helperLog(); return z.string(); });
export const P_ns_nonschema_chain = lazySchema(() => { helpers.helperLog.join(""); return z.string(); });
// a factory defined in another file: its callees resolve against that file
export const P_factory_other_file = lazySchema(declareHidden());
// a function passed by name runs during the call
export const P_callback_ident = lazySchema(() => { ["a"].forEach(pushCb); return z.string(); });
// unanalysed (a): unresolved or external callees
export const P_Ua_unresolved_ident = lazySchema(() => { mysteryFn(); return z.string(); });
export const P_Ua_external_call = lazySchema(() => { extCall(); return z.string(); });
export const P_Ua_external_member = lazySchema(() => { extNs.go(); return z.string(); });
export const P_Ua_unresolved_module = lazySchema(() => { missingFn(); return z.string(); });
export const P_Ua_namespace_call = lazySchema(() => { helpers(); return z.string(); });
export const P_Ua_new_external = lazySchema(() => { new ExtClass(); return z.string(); });
export const P_Ua_new_unresolved = lazySchema(() => { new Mystery(); return z.string(); });
export const P_Ua_dynamic_callee = lazySchema(() => { makeNoter()("a"); return z.string(); });
export const P_Ua_dynamic_import = lazySchema(() => { import("./helper"); return z.string(); });
// A: a helper that writes through a parameter, called with a module value
export const P_A_fill_module = lazySchema(() => { fill(list); return z.string(); });
export const P_A_transitive = lazySchema(() => { outer(list); return z.string(); });
export const P_A_prop_assign = lazySchema(() => { setProp(rec); return z.string(); });
export const P_A_update = lazySchema(() => { bump(rec); return z.string(); });
export const P_A_delete = lazySchema(() => { dropProp(rec); return z.string(); });
export const P_A_object_assign = lazySchema(() => { assignInto(rec); return z.string(); });
export const P_A_callback_param = lazySchema(() => { viaCallback(list); return z.string(); });
export const P_A_param_method = lazySchema(() => { methodOnParam(registrar); return z.string(); });
export const P_A_local_fn_closure = lazySchema(() => { viaLocalFn(list); return z.string(); });
export const P_A_unknown_arg = lazySchema(() => { const x = makeList(); fill(x); return z.string(); });
// B: a local that aliases a module value, or holds a call result of unknown provenance
export const P_B_alias = lazySchema(() => { const x = list; x.push("a"); return z.string(); });
export const P_B_alias_transitive = lazySchema(() => { const x = list; const y = x; y.push("a"); return z.string(); });
export const P_B_destructured = lazySchema(() => { const [first] = nested; first.push("a"); return z.string(); });
export const P_B_unknown_mutation = lazySchema(() => { const x = makeList(); x.push("a"); return z.string(); });
export const P_B_unknown_method = lazySchema(() => { const r = makeList(); r.join(","); return z.string(); });
// C: logging and Promise statics are effects
export const P_C_console = lazySchema(() => { console.log("x"); return z.string(); });
export const P_C_promise = lazySchema(() => { Promise.reject(1); return z.string(); });
// D: the parse family on a schema that is not built in the thunk
export const P_D_parse_module = lazySchema(() => { shapeSchema.parse("x"); return z.string(); });
export const P_D_safeparse_alias = lazySchema(() => { const s = shapeSchema; s.safeParse("x"); return z.string(); });
export const P_D_z_parse = lazySchema(() => { z.parse(shapeSchema, "x"); return z.string(); });
export const P_D_imported_parse = lazySchema(() => { zodParse(shapeSchema, "x"); return z.string(); });
export const P_D_param_parse = lazySchema(() => { parseIt(shapeSchema, "x"); return z.string(); });
// NEGATIVES
export const N_A_fill_local = lazySchema(() => { const local: string[] = []; fill(local); return z.string(); });
export const N_A_fill_fresh = lazySchema(() => { fill([]); return z.string(); });
export const N_A_transitive_local = lazySchema(() => { outer([]); return z.string(); });
export const N_A_param_method_local = lazySchema(() => { const l = { go() {} }; methodOnParam(l); return z.string(); });
export const N_A_param_method_schema = lazySchema(() => { wrapSchema(shapeSchema); return z.string(); });
export const N_A_rebind_only = lazySchema(() => { rebindOnly(list); return z.string(); });
export const N_A_superrefine = lazySchema(() => z.string().superRefine((v, ctx) => { ctx.addIssue({ code: "custom", message: "x" }); }));
export const N_B_fresh_alias = lazySchema(() => { const x = [...list]; x.push("a"); return z.string(); });
export const N_B_zod_local = lazySchema(() => { const e = z.object({}); e.extend({}); return z.string(); });
export const N_B_fresh_returning = lazySchema(() => { const ks = Object.keys(rec); ks.sort(); return z.string(); });
export const N_B_pure_global_local = lazySchema(() => { const p = String(1); p.trim(); const d = Date.now(); d.toFixed(); return z.string(); });
export const N_B_schema_clone_local = lazySchema(() => { const c = shapeSchema.extend({}); c.extend({}); return z.string(); });
export const N_B_alias_schema = lazySchema(() => { const s = shapeSchema; s.extend({}); return z.string(); });
export const N_D_chain_parse = lazySchema(() => { z.string().parse("x"); return z.string(); });
export const N_D_z_parse_fresh = lazySchema(() => { z.parse(z.string(), "x"); return z.string(); });
export const N_D_local_parse = lazySchema(() => { const s = z.string(); s.parse("x"); return z.string(); });
export const N_D_param_parse_fresh = lazySchema(() => { parseIt(z.string(), "x"); return z.string(); });
export const N_B1_local_pure = lazySchema(() => { const reg = () => { const xs: string[] = []; xs.push("a"); return xs; }; reg(); return z.string(); });
export const N_B2_quiet_method = lazySchema(() => { holderObj.quiet("a"); return z.string(); });
export const N_B3_pure_param_init = lazySchema(() => { withDefaultPure(); return z.string(); });
export const N_B5_pure_field = lazySchema(() => { new FieldPure(); return z.string(); });
export const N_B6_pure_base = lazySchema(() => { new PlainDerived(); return z.string(); });
export const N_B7_plain_getter = lazySchema(() => { holderQuiet.x; return z.string(); });
export const N_B13_local_head = lazySchema(() => { let k = ""; for (k of ["a"]) { list.length; } return z.string(); });
export const N_B13_declared_head = lazySchema(() => { for (const k of ["a"]) { list.length; } return z.string(); });
export const N_pure_globals = lazySchema(() => { const keys = Object.keys({ a: 1 }); Array.isArray(keys); Math.max(1, 2); JSON.stringify(keys); String(1).trim(); Number.isInteger(1); Object.freeze(keys); Reflect.ownKeys(keys); Reflect.get(keys, "a"); atob("x"); URL.canParse("x"); return z.string(); });
export const N_ns_schema_chain = lazySchema(() => { helpers.helperSchema.min(1); return z.string(); });
export const N_B2_conditional_local = lazySchema(() => { const v = "a"; const w = (counter === 0 ? v : v.slice(1)).trim(); return z.literal(w); });
export const P_B2_conditional_module = lazySchema(() => { (counter === 0 ? registrar : registrar).note("a"); return z.string(); });
export const N_pure_new = lazySchema(() => { new Set(); new Map(); new URL("http://x"); new RegExp("x"); new Date(); new Error("x"); return z.string(); });
`;

const PLANTED_ZOD_SOURCE = `import { z, meta, describe as zodDescribe } from "zod";
import { lazySchema } from "../framework/lazy-schema";
const dynamicObj = { id: "d" };
const moduleSchema = z.string();
const titled = z.meta({ title: "T" });
// POSITIVES: a registry write observable apart from the thunk's own fresh schema
export const P_Z_with_meta_id = lazySchema(() => z.string().with(z.meta({ id: "x" })));
export const P_Z_meta_dynamic = lazySchema(() => z.string().with(meta(dynamicObj)));
export const P_Z_meta_spread = lazySchema(() => z.string().with(z.meta({ ...dynamicObj })));
export const P_Z_register_inner_id = lazySchema(() => z.object({ a: z.string().register(z.globalRegistry, { id: "x" }) }));
export const P_Z_register_module = lazySchema(() => z.object({ a: moduleSchema.register(z.globalRegistry) }));
// NEGATIVES: metadata with no id, the inner form, the check forms
export const N_Z_describe_nested = lazySchema(() => z.object({ a: z.string().describe("x") }));
export const N_Z_meta_title_inner = lazySchema(() => z.object({ a: z.string().meta({ title: "t" }) }));
export const N_Z_check_describe = lazySchema(() => z.string().check(z.describe("x")));
export const N_Z_with_meta_imported = lazySchema(() => z.string().with(meta({ title: "t" })));
export const N_Z_check_imported_describe = lazySchema(() => z.string().check(zodDescribe("x")));
export const N_Z_check_module_titled = lazySchema(() => z.string().check(titled));
export const N_Z_register_inner_no_id = lazySchema(() => z.object({ a: z.string().register(z.globalRegistry) }));
`;

const PLANTED_HISTORICAL_SOURCE = `const residualList: string[] = [];
function withResidualCapture(id: string, shape: object) {
  residualList.push(id);
  return shape;
}
const shape = { a: 1 };
export const historical = lazySchema(() => withResidualCapture("x", shape));
`;

const PLANTED_RULES_SOURCE = `import { z } from "zod";
import { lazySchema } from "../framework/lazy-schema";
class Foo {}
const base = z.object({});
const contract = { requestSchema: z.string() };
export const P_R1_describe = lazySchema(() => z.string().describe("x"));
export const P_R1_meta = lazySchema(() => z.string().meta({ id: "x" }));
export const P_R1_register = lazySchema(() => z.string().register(z.globalRegistry));
export const P_R1_block = lazySchema(() => {
  return z.string().describe("block");
});
export const P_R1_parens = lazySchema(() => (z.string().describe("parens")));
export const P_R1_nonnull = lazySchema(() => z.string().describe("bang")!);
export const N_R1_nested = lazySchema(() => z.object({ a: z.string().describe("x") }));
export const N_R1_optional = lazySchema(() => z.string().optional());
export const P_R2_instanceof = lazySchema(() => z.instanceof(Foo));
export const N_R2_nested = lazySchema(() => z.object({ a: z.instanceof(Foo) }));
export const P_R3_json = lazySchema(() => z.json());
export const N_R3_nested = lazySchema(() => z.object({ a: z.json() }));
export const P_R4_getter = lazySchema(() => {
  const node = z.object({
    get inner() {
      return node;
    },
  });
  return node;
});
export const P_R4_lazy = lazySchema(() => {
  const node = z.lazy(() => node);
  return node;
});
export const N_R4_plain_local = lazySchema(() => {
  const node = z.string();
  return node;
});
export const P_R6_module_ident = lazySchema(() => P_R3_json);
export const P_R6_property_chain = lazySchema(() => contract.requestSchema);
export const P_R6_element_chain = lazySchema(() => contract["requestSchema"]);
export const P_R6_block_return = lazySchema(() => {
  return base;
});
export const N_R6_call = lazySchema(() => base.extend({}));
export const N_R6_thunk_local = lazySchema(() => {
  const own = z.string();
  return own.optional();
});
export const N_R6_thunk_local_ident = lazySchema(() => {
  const own = z.string();
  return own;
});
`;

const PLANTED_DIR = path.join(PROTOCOL_SRC, "sweepctl");
const PLANTED_PLANTED_ABS = path.join(PLANTED_DIR, "planted.ts");
const PLANTED_HELPER_ABS = path.join(PLANTED_DIR, "helper.ts");
const PLANTED_SHAPES_ABS = path.join(PLANTED_DIR, "shapes.ts");
const PLANTED_ZOD_ABS = path.join(PLANTED_DIR, "zplanted.ts");
const PLANTED_HISTORICAL_ABS = path.join(PLANTED_DIR, "historical.ts");
const PLANTED_RULES_ABS = path.join(PLANTED_DIR, "rules.ts");

type Expectation = {
  readonly name: string;
  readonly kinds: readonly string[];
};

const R5_POSITIVES: readonly Expectation[] = [
  { name: "P_S1_assign", kinds: ["S1 assign"] },
  { name: "P_S1_prop", kinds: ["S1 assign"] },
  { name: "P_S1_destructure", kinds: ["S1 destructuring-assign"] },
  { name: "P_S2_update", kinds: ["S2 update"] },
  { name: "P_S3_delete", kinds: ["S3 delete"] },
  { name: "P_S4_mapset", kinds: ["S4 mutator"] },
  { name: "P_S4_setadd", kinds: ["S4 mutator"] },
  { name: "P_S4_push", kinds: ["S4 mutator"] },
  { name: "P_S4_objassign", kinds: ["S4 object-mutator"] },
  { name: "P_Z_meta", kinds: ["Z registry"] },
  { name: "P_inter_helper", kinds: ["S4 mutator"] },
  { name: "P_inter_namespace", kinds: ["S4 mutator"] },
  { name: "P_callback", kinds: ["S4 mutator"] },
  { name: "P_iife", kinds: ["S1 assign"] },
  { name: "P_new", kinds: ["S4 mutator"] },
];

const R5_NEGATIVES: readonly string[] = [
  "N_local",
  "N_fresh_chain",
  "N_pure_helper",
  "N_returned_closure",
  "N_zod_set",
];

const SHAPE_POSITIVES: readonly Expectation[] = [
  { name: "P_B1_arrow", kinds: ["S4 mutator"] },
  { name: "P_B1_declaration", kinds: ["S2 update"] },
  { name: "P_B1_closure", kinds: ["S2 update"] },
  { name: "P_B2_object_method", kinds: ["S4 mutator"] },
  { name: "P_B2_local_object_method", kinds: ["S4 mutator"] },
  { name: "P_B2_class_method", kinds: ["S2 update"] },
  { name: "P_B2_inherited_method", kinds: ["S2 update"] },
  { name: "P_B2_destructured_receiver", kinds: [UNANALYSED_KIND] },
  { name: "P_B2_unresolvable", kinds: [UNANALYSED_KIND] },
  { name: "P_factory_other_file", kinds: ["S4 mutator"] },
  { name: "P_B3_param_init", kinds: ["S4 mutator"] },
  { name: "P_B4_tagged", kinds: ["S4 mutator"] },
  { name: "P_B5_field_init", kinds: ["S2 update"] },
  { name: "P_B6_inherited_ctor", kinds: ["S4 mutator"] },
  { name: "P_B6_unresolvable_base", kinds: [UNANALYSED_KIND] },
  { name: "P_B7_object_getter", kinds: ["S2 update"] },
  { name: "P_B7_class_getter", kinds: ["S2 update"] },
  { name: "P_B9_call", kinds: [UNANALYSED_KIND] },
  { name: "P_B9_apply", kinds: [UNANALYSED_KIND] },
  { name: "P_B9_bind", kinds: [UNANALYSED_KIND] },
  { name: "P_B10_factory_result", kinds: [UNANALYSED_KIND] },
  { name: "P_B11_bound", kinds: [UNANALYSED_KIND] },
  { name: "P_B10_local_factory_result", kinds: [UNANALYSED_KIND] },
  { name: "P_B13_for_of", kinds: ["S1 assign"] },
  { name: "P_B13_for_in", kinds: ["S1 assign"] },
  { name: "P_B13_destructure", kinds: ["S1 destructuring-assign"] },
  { name: "P_B14_element_call", kinds: [UNANALYSED_KIND] },
  { name: "P_B17_prototype_call", kinds: [UNANALYSED_KIND] },
  { name: "P_B18_reflect_apply", kinds: [UNANALYSED_KIND] },
  { name: "P_Uf_reflect_construct", kinds: [UNANALYSED_KIND] },
  { name: "P_Uf_object_unlisted", kinds: [UNANALYSED_KIND] },
  { name: "P_callback_ident", kinds: ["S4 mutator"] },
  { name: "P_A_fill_module", kinds: ["S4 mutator"] },
  { name: "P_A_transitive", kinds: ["S4 mutator"] },
  { name: "P_A_prop_assign", kinds: ["S1 assign"] },
  { name: "P_A_update", kinds: ["S2 update"] },
  { name: "P_A_delete", kinds: ["S3 delete"] },
  { name: "P_A_object_assign", kinds: ["S4 object-mutator"] },
  { name: "P_A_callback_param", kinds: ["S4 mutator"] },
  { name: "P_A_param_method", kinds: [UNANALYSED_KIND] },
  { name: "P_A_local_fn_closure", kinds: ["S4 mutator"] },
  { name: "P_A_unknown_arg", kinds: [UNANALYSED_KIND] },
  { name: "P_B_alias", kinds: ["S4 mutator"] },
  { name: "P_B_alias_transitive", kinds: ["S4 mutator"] },
  { name: "P_B_destructured", kinds: ["S4 mutator"] },
  { name: "P_B_unknown_mutation", kinds: [UNANALYSED_KIND] },
  { name: "P_B_unknown_method", kinds: [UNANALYSED_KIND] },
  { name: "P_C_console", kinds: [UNANALYSED_KIND] },
  { name: "P_C_promise", kinds: [UNANALYSED_KIND] },
  { name: "P_D_parse_module", kinds: [UNANALYSED_KIND] },
  { name: "P_D_safeparse_alias", kinds: [UNANALYSED_KIND] },
  { name: "P_D_z_parse", kinds: [UNANALYSED_KIND] },
  { name: "P_D_imported_parse", kinds: [UNANALYSED_KIND] },
  { name: "P_D_param_parse", kinds: [UNANALYSED_KIND] },
  { name: "P_Uc_this_receiver", kinds: [UNANALYSED_KIND] },
  { name: "P_B5_local_class", kinds: ["S2 update"] },
  { name: "P_new_local_function", kinds: ["S2 update"] },
  { name: "P_new_module_function", kinds: ["S4 mutator"] },
  { name: "P_ns_member_not_function", kinds: [UNANALYSED_KIND] },
  { name: "P_ns_nonschema_chain", kinds: [UNANALYSED_KIND] },
  {
    name: "P_B2_conditional_module",
    kinds: [UNANALYSED_KIND, UNANALYSED_KIND],
  },
  { name: "P_Ua_unresolved_ident", kinds: [UNANALYSED_KIND] },
  { name: "P_Ua_external_call", kinds: [UNANALYSED_KIND] },
  { name: "P_Ua_external_member", kinds: [UNANALYSED_KIND] },
  { name: "P_Ua_unresolved_module", kinds: [UNANALYSED_KIND] },
  { name: "P_Ua_namespace_call", kinds: [UNANALYSED_KIND] },
  { name: "P_Ua_new_external", kinds: [UNANALYSED_KIND] },
  { name: "P_Ua_new_unresolved", kinds: [UNANALYSED_KIND] },
  { name: "P_Ua_dynamic_callee", kinds: [UNANALYSED_KIND] },
  { name: "P_Ua_dynamic_import", kinds: [UNANALYSED_KIND] },
];

const SHAPE_NEGATIVES: readonly string[] = [
  "N_B1_local_pure",
  "N_B2_quiet_method",
  "N_B3_pure_param_init",
  "N_B5_pure_field",
  "N_B6_pure_base",
  "N_B7_plain_getter",
  "N_B13_local_head",
  "N_B13_declared_head",
  "N_A_fill_local",
  "N_A_fill_fresh",
  "N_A_transitive_local",
  "N_A_param_method_local",
  "N_A_param_method_schema",
  "N_A_rebind_only",
  "N_A_superrefine",
  "N_B_fresh_alias",
  "N_B_zod_local",
  "N_B_fresh_returning",
  "N_B_alias_schema",
  "N_B_pure_global_local",
  "N_B_schema_clone_local",
  "N_D_chain_parse",
  "N_D_z_parse_fresh",
  "N_D_local_parse",
  "N_D_param_parse_fresh",
  "N_ns_schema_chain",
  "N_B2_conditional_local",
  "N_pure_globals",
  "N_pure_new",
];

const ZOD_POSITIVES: readonly string[] = [
  "P_Z_with_meta_id",
  "P_Z_meta_dynamic",
  "P_Z_meta_spread",
  "P_Z_register_inner_id",
  "P_Z_register_module",
];

const ZOD_NEGATIVES: readonly string[] = [
  "N_Z_describe_nested",
  "N_Z_meta_title_inner",
  "N_Z_check_describe",
  "N_Z_with_meta_imported",
  "N_Z_check_imported_describe",
  "N_Z_check_module_titled",
  "N_Z_register_inner_no_id",
];

function scanOverlay(
  files: readonly string[],
  overlay: ReadonlyMap<string, string>,
): ThunkScanResult {
  return scanThunkRules({
    files,
    overlay,
    protoSrc: PROTOCOL_SRC,
    commonSrc: COMMON_SRC,
    contentRoot: TRAYCER_ROOT,
  });
}

function scanRulesPlanted(): ThunkScanResult {
  return scanOverlay(
    [PLANTED_RULES_ABS],
    new Map([[PLANTED_RULES_ABS, PLANTED_RULES_SOURCE]]),
  );
}

function scanR5Planted(): ThunkScanResult {
  return scanOverlay(
    [PLANTED_PLANTED_ABS],
    new Map([
      [PLANTED_PLANTED_ABS, PLANTED_PLANTED_SOURCE],
      [PLANTED_HELPER_ABS, PLANTED_HELPER_SOURCE],
    ]),
  );
}

function scanShapesPlanted(): ThunkScanResult {
  return scanOverlay(
    [PLANTED_SHAPES_ABS],
    new Map([
      [PLANTED_SHAPES_ABS, PLANTED_SHAPES_SOURCE],
      [PLANTED_HELPER_ABS, PLANTED_HELPER_SOURCE],
    ]),
  );
}

function scanZodPlanted(): ThunkScanResult {
  return scanOverlay(
    [PLANTED_ZOD_ABS],
    new Map([[PLANTED_ZOD_ABS, PLANTED_ZOD_SOURCE]]),
  );
}

function scanHistoricalPlanted(): ThunkScanResult {
  return scanOverlay(
    [PLANTED_HISTORICAL_ABS],
    new Map([[PLANTED_HISTORICAL_ABS, PLANTED_HISTORICAL_SOURCE]]),
  );
}

function r5Kinds(result: ThunkScanResult, name: string): string[] {
  return hitsOf(result, "R5", name).map((hit) => hit.kind);
}

/** One line per control whose R5 kinds differ from the expectation, so a single broken branch names every control it breaks. */
function r5Mismatches(
  result: ThunkScanResult,
  positives: readonly Expectation[],
  negatives: readonly string[],
): string[] {
  const out: string[] = [];
  for (const positive of positives) {
    const got = r5Kinds(result, positive.name);
    if (JSON.stringify(got) !== JSON.stringify(positive.kinds)) {
      out.push(
        `${positive.name}: expected ${JSON.stringify(positive.kinds)}, got ${JSON.stringify(got)}`,
      );
    }
  }
  for (const name of negatives) {
    const got = r5Kinds(result, name);
    if (got.length > 0) {
      out.push(`${name}: expected no R5 hit, got ${JSON.stringify(got)}`);
    }
  }
  return out;
}

describe("lazySchema thunk rules scan", () => {
  it("R1 flags outermost describe/meta/register and ignores nested or other calls", () => {
    const result = scanRulesPlanted();
    expect(
      hitsOf(result, "R1", "P_R1_describe").map((hit) => hit.kind),
    ).toEqual(["describe"]);
    expect(hitsOf(result, "R1", "P_R1_meta").map((hit) => hit.kind)).toEqual([
      "meta",
    ]);
    expect(
      hitsOf(result, "R1", "P_R1_register").map((hit) => hit.kind),
    ).toEqual(["register"]);
    expect(hitsOf(result, "R1", "P_R1_block").map((hit) => hit.kind)).toEqual([
      "describe",
    ]);
    expect(hitsOf(result, "R1", "P_R1_parens").map((hit) => hit.kind)).toEqual([
      "describe",
    ]);
    expect(hitsOf(result, "R1", "P_R1_nonnull").map((hit) => hit.kind)).toEqual(
      ["describe"],
    );
    expect(hitsOf(result, "R1", "N_R1_nested")).toEqual([]);
    expect(hitsOf(result, "R1", "N_R1_optional")).toEqual([]);
    expect(hitsOf(result, "R1", "P_R2_instanceof")).toEqual([]);
    expect(hitsOf(result, "R1", "P_R3_json")).toEqual([]);

    const r5 = scanR5Planted();
    expect(hitsOf(r5, "R1", "P_Z_meta").map((hit) => hit.kind)).toEqual([
      "meta",
    ]);

    const zod = scanZodPlanted();
    for (const name of ZOD_POSITIVES.concat(ZOD_NEGATIVES)) {
      expect(hitsOf(zod, "R1", name), name).toEqual([]);
    }
  });

  it("R2 flags outermost z.instanceof and ignores nested instanceof", () => {
    const result = scanRulesPlanted();
    expect(
      hitsOf(result, "R2", "P_R2_instanceof").map((hit) => hit.kind),
    ).toEqual(["instanceof"]);
    expect(hitsOf(result, "R2", "N_R2_nested")).toEqual([]);
    expect(hitsOf(result, "R2", "P_R1_describe")).toEqual([]);
  });

  it("R3 flags outermost z.json and ignores nested json", () => {
    const result = scanRulesPlanted();
    expect(hitsOf(result, "R3", "P_R3_json").map((hit) => hit.kind)).toEqual([
      "json",
    ]);
    expect(hitsOf(result, "R3", "N_R3_nested")).toEqual([]);
    expect(hitsOf(result, "R3", "P_R1_describe")).toEqual([]);
  });

  it("R4 flags a returned thunk-local const that a nested getter or z.lazy references", () => {
    const result = scanRulesPlanted();
    expect(hitsOf(result, "R4", "P_R4_getter").map((hit) => hit.kind)).toEqual([
      "self-ref",
    ]);
    expect(hitsOf(result, "R4", "P_R4_lazy").map((hit) => hit.kind)).toEqual([
      "self-ref",
    ]);
    expect(hitsOf(result, "R4", "N_R4_plain_local")).toEqual([]);
    expect(hitsOf(result, "R4", "P_R6_module_ident")).toEqual([]);
    expect(hitsOf(result, "R4", "P_R1_describe")).toEqual([]);
  });

  it("R6 flags a thunk that returns an existing value: an identifier or a property chain the thunk does not declare", () => {
    const result = scanRulesPlanted();
    for (const name of [
      "P_R6_module_ident",
      "P_R6_property_chain",
      "P_R6_element_chain",
      "P_R6_block_return",
    ]) {
      expect(
        hitsOf(result, "R6", name).map((hit) => hit.kind),
        name,
      ).toEqual(["alias"]);
    }
    for (const name of [
      "N_R6_call",
      "N_R6_thunk_local",
      "N_R6_thunk_local_ident",
      "N_R4_plain_local",
      "P_R1_describe",
      "P_R3_json",
    ]) {
      expect(hitsOf(result, "R6", name), name).toEqual([]);
    }
  });

  it("R5 flags each planted side-effect branch and ignores the planted negatives", () => {
    const result = scanR5Planted();
    expect(result.thunkCount).toBe(R5_POSITIVES.length + R5_NEGATIVES.length);
    expect(r5Mismatches(result, R5_POSITIVES, R5_NEGATIVES)).toEqual([]);
  });

  it("R5 catches the shapes the first walker missed, and reports what it cannot follow as unanalysed", () => {
    const result = scanShapesPlanted();
    expect(result.thunkCount).toBe(
      SHAPE_POSITIVES.length + SHAPE_NEGATIVES.length,
    );
    expect(r5Mismatches(result, SHAPE_POSITIVES, SHAPE_NEGATIVES)).toEqual([]);
  });

  it("R5 names each unanalysed call with a stable label", () => {
    const result = scanShapesPlanted();
    const label = (name: string): string[] =>
      hitsOf(result, "R5", name)
        .filter(isUnanalysedHit)
        .map((hit) => hit.detail);
    expect(label("P_B2_unresolvable")).toEqual([
      "method-on-non-schema registrar.note (protocol/src/sweepctl/shapes.ts)",
    ]);
    expect(label("P_B2_destructured_receiver")).toEqual([
      "method-on-non-schema destructuredA.extend (protocol/src/sweepctl/shapes.ts)",
    ]);
    expect(label("P_A_param_method")).toEqual([
      "param-method o.go (protocol/src/sweepctl/shapes.ts)",
    ]);
    expect(label("P_A_unknown_arg")).toEqual([
      "argument-of-unknown-provenance t (protocol/src/sweepctl/shapes.ts)",
    ]);
    expect(label("P_B_unknown_mutation")).toEqual([
      "mutation-on-unknown-provenance x (protocol/src/sweepctl/shapes.ts)",
    ]);
    expect(label("P_D_parse_module")).toEqual([
      "parse-runs-callbacks shapeSchema.parse (protocol/src/sweepctl/shapes.ts)",
    ]);
    expect(label("P_D_z_parse")).toEqual([
      "parse-runs-callbacks z.parse (protocol/src/sweepctl/shapes.ts)",
    ]);
    expect(label("P_D_param_parse")).toEqual([
      "parse-runs-callbacks s.parse (protocol/src/sweepctl/shapes.ts)",
    ]);
    expect(label("P_C_console")).toEqual([
      "method-on-unresolved console.log (protocol/src/sweepctl/shapes.ts)",
    ]);
    expect(label("P_B9_call")).toEqual([
      "call-apply-bind pushIt.call (protocol/src/sweepctl/shapes.ts)",
    ]);
    expect(label("P_B10_factory_result")).toEqual([
      "callee-not-function noteFn (protocol/src/sweepctl/shapes.ts)",
    ]);
    expect(label("P_B14_element_call")).toEqual([
      'element-access-call list["push"] (protocol/src/sweepctl/shapes.ts)',
    ]);
    expect(label("P_B18_reflect_apply")).toEqual([
      "call-apply-bind Reflect.apply (protocol/src/sweepctl/shapes.ts)",
    ]);
    expect(label("P_Uf_reflect_construct")).toEqual([
      "method-on-unresolved Reflect.construct (protocol/src/sweepctl/shapes.ts)",
    ]);
    expect(label("P_Ua_external_call")).toEqual([
      "external external-pkg:extCall (protocol/src/sweepctl/shapes.ts)",
    ]);
    expect(label("P_B6_unresolvable_base")).toEqual([
      "class-base ExternalBase (protocol/src/sweepctl/shapes.ts)",
    ]);
  });

  it("R5-Z flags only a registry write observable apart from the thunk's own fresh schema", () => {
    const result = scanZodPlanted();
    expect(result.thunkCount).toBe(ZOD_POSITIVES.length + ZOD_NEGATIVES.length);
    expect(
      r5Mismatches(
        result,
        ZOD_POSITIVES.map((name) => ({ name, kinds: ["Z registry"] })),
        ZOD_NEGATIVES,
      ),
    ).toEqual([]);
  });

  it("R5 flags the historical withResidualCapture-inside-thunk form", () => {
    const result = scanHistoricalPlanted();
    expect(result.thunkCount).toBe(1);
    expect(hitsOf(result, "R5", "historical").map((hit) => hit.kind)).toContain(
      "S4 mutator",
    );
  });

  it("production protocol and OSS client sources have zero R1-R6 hits, unanalysed calls exactly the allow-list, and at least 3000 thunks", () => {
    const files = gitListedFiles(TRAYCER_ROOT, SCAN_PREFIXES);
    expect(files.length).toBeGreaterThan(0);
    const result = scanThunkRules({
      files,
      overlay: new Map(),
      protoSrc: PROTOCOL_SRC,
      commonSrc: COMMON_SRC,
      contentRoot: TRAYCER_ROOT,
    });
    expect(result.thunkCount).toBeGreaterThanOrEqual(3000);
    expect(
      result.hits.filter((hit) => !isUnanalysedHit(hit)).map(formatHit),
    ).toEqual([]);
    expect(
      allowListMismatches(
        unanalysedCountsOf(result),
        new Map(
          [...ALLOWED_UNANALYSED].map(([label, entry]) => [label, entry.count]),
        ),
      ),
    ).toEqual([]);
  }, 60_000);

  it("allow-list mismatches name the label, in both directions", () => {
    const actual = new Map([
      ["a", 2],
      ["b", 1],
    ]);
    expect(
      allowListMismatches(
        actual,
        new Map([
          ["a", 1],
          ["c", 1],
        ]),
      ),
    ).toEqual([
      "a: allow-list says 1 occurrence(s), found 2; judge the difference and update the count",
      "b: 1 occurrence(s), not in the allow-list; judge each and add it with a reason only if it is pure",
      "c: stale allow-list entry (1 occurrence(s)), found none; remove it",
    ]);
    expect(allowListMismatches(actual, new Map(actual))).toEqual([]);
  });

  it("a further call under an allow-listed label is a second occurrence", () => {
    const plant = (source: string): ThunkScanResult =>
      scanOverlay(
        [PLANTED_SHAPES_ABS],
        new Map([
          [PLANTED_SHAPES_ABS, source],
          [PLANTED_HELPER_ABS, PLANTED_HELPER_SOURCE],
        ]),
      );
    const label =
      "method-on-non-schema registrar.note (protocol/src/sweepctl/shapes.ts)";
    const before = plant(PLANTED_SHAPES_SOURCE);
    const after = plant(
      PLANTED_SHAPES_SOURCE.replace(
        "export const P_B2_unresolvable =",
        'export const P_B2_unresolvable_again = lazySchema(() => { registrar.note("b"); return z.string(); });\nexport const P_B2_unresolvable =',
      ),
    );
    const beforeCount = unanalysedCountsOf(before).get(label);
    expect(beforeCount).toBeGreaterThan(0);
    expect(unanalysedCountsOf(after).get(label)).toBe((beforeCount ?? 0) + 1);
    expect(
      unanalysedLabelsOf(after).filter((entry) => entry === label),
    ).toEqual([label]);
  });
});

/**
 * The premises the allow-list reasons rest on. An entry's label can stay the
 * same while its reason goes false (a `g` flag on a module-scope regex, an
 * alias retargeted, a callback added to a schema), so the premise is asserted
 * here, next to the list, from the source itself.
 */
function sourceFileOf(relative: string): ts.SourceFile {
  const abs = path.join(TRAYCER_ROOT, relative);
  return ts.createSourceFile(
    abs,
    readFileSync(abs, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
}

function unwrapExpression(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isNonNullExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function topLevelDeclaration(
  sf: ts.SourceFile,
  name: string,
): ts.VariableDeclaration | undefined {
  for (const statement of sf.statements) {
    if (!ts.isVariableStatement(statement)) {
      continue;
    }
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.name.text === name) {
        return declaration;
      }
    }
  }
  return undefined;
}

function topLevelInitializer(relative: string, name: string): ts.Expression {
  const declaration = topLevelDeclaration(sourceFileOf(relative), name);
  const initializer = declaration?.initializer;
  if (initializer === undefined) {
    throw new Error(`${name} has no top-level initializer in ${relative}`);
  }
  return unwrapExpression(initializer);
}

/** The callee names of every call inside `node`: `.transform(` gives "transform". */
function calleeNamesIn(node: ts.Node): string[] {
  const names: string[] = [];
  const visit = (child: ts.Node): void => {
    if (ts.isCallExpression(child)) {
      const callee = unwrapExpression(child.expression);
      if (ts.isPropertyAccessExpression(callee)) {
        names.push(callee.name.text);
      } else if (ts.isIdentifier(callee)) {
        names.push(callee.text);
      }
    }
    ts.forEachChild(child, visit);
  };
  visit(node);
  return names;
}

function isLazySchemaCall(expression: ts.Expression): boolean {
  const inner = unwrapExpression(expression);
  return (
    ts.isCallExpression(inner) &&
    ts.isIdentifier(inner.expression) &&
    inner.expression.text === "lazySchema"
  );
}

/**
 * Whether every element of the top-level array `name` is a zod schema: a
 * `lazySchema(` call, an identifier declared as one or destructured out of
 * another such array, or a spread of another such array.
 */
function isArrayOfSchemas(
  sf: ts.SourceFile,
  name: string,
  depth: number,
): boolean {
  if (depth > 6) {
    return false;
  }
  const declaration = topLevelDeclaration(sf, name);
  if (declaration !== undefined && declaration.initializer !== undefined) {
    const initializer = unwrapExpression(declaration.initializer);
    if (ts.isArrayLiteralExpression(initializer)) {
      return initializer.elements.every((element) =>
        isSchemaElement(sf, element, depth + 1),
      );
    }
    return false;
  }
  return destructuredFromSchemaArray(sf, name, depth + 1);
}

function isSchemaElement(
  sf: ts.SourceFile,
  element: ts.Expression,
  depth: number,
): boolean {
  if (ts.isSpreadElement(element)) {
    const spread = unwrapExpression(element.expression);
    return (
      ts.isIdentifier(spread) && isArrayOfSchemas(sf, spread.text, depth + 1)
    );
  }
  const inner = unwrapExpression(element);
  if (isLazySchemaCall(inner)) {
    return true;
  }
  if (ts.isIdentifier(inner)) {
    const declaration = topLevelDeclaration(sf, inner.text);
    if (declaration !== undefined && declaration.initializer !== undefined) {
      return isLazySchemaCall(declaration.initializer);
    }
    return destructuredFromSchemaArray(sf, inner.text, depth + 1);
  }
  return false;
}

/** `name` is a binding of `const [..] = other` where `other` is an array of schemas. */
function destructuredFromSchemaArray(
  sf: ts.SourceFile,
  name: string,
  depth: number,
): boolean {
  for (const statement of sf.statements) {
    if (!ts.isVariableStatement(statement)) {
      continue;
    }
    for (const declaration of statement.declarationList.declarations) {
      if (
        !ts.isArrayBindingPattern(declaration.name) ||
        declaration.initializer === undefined
      ) {
        continue;
      }
      const source = unwrapExpression(declaration.initializer);
      const bindsName = declaration.name.elements.some(
        (element) =>
          ts.isBindingElement(element) &&
          ts.isIdentifier(element.name) &&
          element.name.text === name,
      );
      if (bindsName && ts.isIdentifier(source)) {
        return isArrayOfSchemas(sf, source.text, depth);
      }
    }
  }
  return false;
}

const SUBSCRIBE_SOURCE = "protocol/src/host/agent/gui/subscribe.ts";
const REGEX_PREMISES: readonly {
  readonly file: string;
  readonly name: string;
}[] = [
  {
    file: "protocol/src/config/installation-records.ts",
    name: "SEMVER_PATTERN",
  },
  { file: "protocol/src/config/installation-records.ts", name: "SHA256_HEX" },
  {
    file: "protocol/src/persistence/epic/role-claims.ts",
    name: "SURVIVING_CONTROL_CHARACTER",
  },
  {
    file: "protocol/src/host/workspace/unary-schemas.ts",
    name: "ABSOLUTE_HOST_PATH",
  },
];
const CALLBACK_METHODS = [
  "refine",
  "superRefine",
  "transform",
  "preprocess",
  "check",
  "custom",
  "pipe",
  "with",
  "codec",
  "lazy",
  "overwrite",
];

describe("allow-list premises", () => {
  it("each module-scope regex the allow-list calls `.test` on is a literal with neither a g nor a y flag", () => {
    for (const { file, name } of REGEX_PREMISES) {
      const initializer = topLevelInitializer(file, name);
      expect(ts.isRegularExpressionLiteral(initializer), name).toBe(true);
      if (ts.isRegularExpressionLiteral(initializer)) {
        const flags = initializer.text.slice(
          initializer.text.lastIndexOf("/") + 1,
        );
        expect(flags, `${name} flags`).not.toMatch(/[gy]/);
      }
    }
  });

  it("PROVIDER_AUTH_STATUS_SCHEMA and worktreeListAllForHostRequestSchemaV12 are aliases of their targets", () => {
    expect(PROVIDER_AUTH_STATUS_SCHEMA).toBe(PROVIDER_AUTH_STATUS_SCHEMA_V20);
    expect(worktreeListAllForHostRequestSchemaV12).toBe(
      worktreeListAllForHostRequestSchemaV11,
    );
  });

  it("absoluteHostPathSchema is a lazySchema with no callback-running method in its initialiser", () => {
    const initializer = topLevelInitializer(
      "protocol/src/host/workspace/unary-schemas.ts",
      "absoluteHostPathSchema",
    );
    expect(isLazySchemaCall(initializer)).toBe(true);
    const callbacks = calleeNamesIn(initializer).filter((name) =>
      CALLBACK_METHODS.includes(name),
    );
    expect(callbacks).toEqual([]);
  });

  it("BROWSER_VIEWPORT_MAX_PIXELS is a number and the hostStatus response schemas are z.ZodObject", () => {
    expect(typeof BROWSER_VIEWPORT_MAX_PIXELS).toBe("number");
    expect(hostStatusV13.responseSchema instanceof z.ZodObject).toBe(true);
    expect(hostStatusV14.responseSchema instanceof z.ZodObject).toBe(true);
    expect(hostStatusV15.responseSchema instanceof z.ZodObject).toBe(true);
  });

  it("every element of the chat-subscribe option arrays, and the four destructured PreAuto frames, is a zod schema", () => {
    const sf = sourceFileOf(SUBSCRIBE_SOURCE);
    expect(
      isArrayOfSchemas(
        sf,
        "chatSubscribeClientFrameSchemaOptionsBeforeInterview",
        0,
      ),
    ).toBe(true);
    expect(
      isArrayOfSchemas(sf, "chatSubscribeClientFrameSchemaV17ToV19Options", 0),
    ).toBe(true);
    for (const name of [
      "queueSteerNowClientFrameSchemaPreAuto",
      "queueSettingsUpdateClientFrameSchemaPreAuto",
      "queueSettingsRestampClientFrameSchemaPreAuto",
      "activePermissionModeUpdateClientFrameSchemaPreAuto",
    ]) {
      expect(destructuredFromSchemaArray(sf, name, 0), name).toBe(true);
    }
  });

  it("getSortedNumberKeys returns a sort of a map of Object.keys, a fresh array (the premise of the keys.at entry)", () => {
    const sf = sourceFileOf("protocol/src/framework/versioned-record.ts");
    let returned: ts.Expression | undefined = undefined;
    for (const statement of sf.statements) {
      if (
        ts.isFunctionDeclaration(statement) &&
        statement.name?.text === "getSortedNumberKeys"
      ) {
        for (const inner of statement.body?.statements ?? []) {
          if (ts.isReturnStatement(inner) && inner.expression !== undefined) {
            returned = unwrapExpression(inner.expression);
          }
        }
      }
    }
    expect(returned).not.toBeUndefined();
    const chain: string[] = [];
    let current = returned;
    while (current !== undefined && ts.isCallExpression(current)) {
      const callee = unwrapExpression(current.expression);
      if (!ts.isPropertyAccessExpression(callee)) {
        break;
      }
      const receiver = unwrapExpression(callee.expression);
      if (ts.isIdentifier(receiver) && receiver.text === "Object") {
        chain.push(`Object.${callee.name.text}`);
        break;
      }
      chain.push(callee.name.text);
      current = receiver;
    }
    expect(chain).toEqual(["sort", "map", "Object.keys"]);
  });
});
