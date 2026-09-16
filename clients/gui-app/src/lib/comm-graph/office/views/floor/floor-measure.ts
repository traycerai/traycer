/**
 * How big the Floor WOULD come to, without building it.
 *
 * Auto compares this against the tile to choose a view, and it runs before the
 * winner is planned - so it must be the packing arithmetic and nothing else.
 * `officeFloorGrid` is the part of `layoutOffice` that decides the grid:
 * `buildFloors` and the fold to `cols × rows`. Everything the plan does after
 * that - the walkable grid, the pods' flood fills, the errand spots, the
 * fittings - fills the grid in rather than sizing it, and it is where the
 * review measured a thousand-root plan spending most of its time.
 */
import { OFFICE_TILE } from "@/lib/comm-graph/office/office-types";
import { officeFloorGrid } from "@/lib/comm-graph/office/office-layout";
import type { OfficeMeasureFn } from "@/lib/comm-graph/office/views/office-view";

export const measureFloor: OfficeMeasureFn = (input) => {
  const grid = officeFloorGrid(input.agents);
  return { width: grid.cols * OFFICE_TILE, height: grid.rows * OFFICE_TILE };
};
