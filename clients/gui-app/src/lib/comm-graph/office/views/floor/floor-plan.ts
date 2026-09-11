/**
 * The Floor's plan: today's `layoutOffice`, behind the contract's signature.
 *
 * It is deliberately the thinnest wrapper in the set. `layoutOffice` already
 * returns a whole `OfficeLayout` - T1 decorated it in place with seat ids,
 * anchors, corridors, signs and the stability flags - so there is nothing left
 * to add here, and adding anything would be a second packer's worth of Floor
 * behaviour living outside the packer.
 *
 * Three inputs are IGNORED, each for its own reason:
 *
 * - `occupancy` and `needsCapacity`, because the Floor has no reserve seats:
 *   every agent gets a desk, so there is never a claimed seat to route around
 *   and never a shortfall to make room for.
 * - `partition`, because the Floor's rooms are the lineage's own cabins and
 *   pods, which `layoutOffice` reads off `parentId` directly. The partition is
 *   what the views that BUILD from teams need.
 * - `viewport` and `previous`, because the packing is a pure function of the
 *   agent set: the Floor re-packs from scratch every time, which is exactly
 *   what `stable: false` says about it.
 */
import { layoutOffice } from "@/lib/comm-graph/office/office-layout";
import type { OfficePlanFn } from "@/lib/comm-graph/office/views/office-view";

export const planFloor: OfficePlanFn = (input) => layoutOffice(input.agents);
