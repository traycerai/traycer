/**
 * WHICH VIEWS PLAN CIVIC ROOMS, and the flip is the whole interface.
 *
 * K1 gives the rooms to the Floor alone; K2 turns each of the others on as it
 * builds them. A view that is `false` here is asserted to plan NO civic rooms
 * and NO road, which is what makes the table the only way in: a view that grew
 * rooms without being enrolled reddens rather than quietly shipping half a
 * layer, and enrolling one is a one-line edit rather than a case rewrite.
 *
 * ONE TABLE, not one per suite. Both the plan cases and the scene cases gate on
 * it, and two copies would be two things to flip - a view enrolled in the plans
 * but not the scene would grow rooms nobody walks to, and every civic scene
 * case for it would SKIP rather than fail, which is the failure mode that
 * hides. It lives here rather than beside either suite because neither owns it;
 * `counting-array-ctor.ts` is the precedent for a test-support module in this
 * directory.
 */
import type {
  OfficeCivicKind,
  OfficeViewId,
} from "@/lib/comm-graph/office/office-types";

export const CIVIC_ROOMS_EXPECTED: Readonly<Record<OfficeViewId, boolean>> = {
  floor: true,
  towers: true,
  building: true,
  "mission-control": true,
  campus: true,
  city: true,
};

/**
 * WHICH ENROLLED VIEWS PLAN A STREET, which is not all of them.
 *
 * Four of the five offices are buildings with a way in from outside, and a
 * vehicle pulls up at their kerbs. Mission control is ONE AMPHITHEATRE: nothing
 * drives into a hall, so it plans no road and every one of its four rooms names
 * a null kerb - C6's own reading, and the reason its medbay is marked by a siren
 * light rather than by an ambulance.
 *
 * A SECOND TABLE rather than a tolerated `null`, for the reason the first one
 * exists: a view that lost its road would otherwise pass by having no kerbs to
 * misplace, and the whole point of the tables is that the layer can only be
 * entered, or left, on purpose.
 */
export const CIVIC_ROADS_EXPECTED: Readonly<Record<OfficeViewId, boolean>> = {
  floor: true,
  towers: true,
  building: true,
  "mission-control": false,
  campus: true,
  city: true,
};

/**
 * WHERE THE AMBULANCE ACTUALLY WAITS FOR ITS RIDER, which is not everywhere.
 *
 * A vehicle dwells at the kerb for at least four seconds, at most twelve, and in
 * between for as long as its rider takes to settle. Which of those three bounds
 * is the one DOING the waiting is a fact about the view's geometry, and in one
 * view it is not the rider.
 *
 * Campus puts the sick bay at the first content column with its kerb on the lane
 * beside its own door, so the walk from a desk to a bed is shorter than the
 * ambulance's own trip: measured, the rider settles at tick 37 and the vehicle
 * reaches the kerb at 57 - twenty ticks after the patient is already in bed - and
 * three ticks from desk to bed in the small fixture. The ambulance then waits the
 * four-second floor and leaves, which meets the contract at both ends. The other
 * three views give the rider bounds of 120, 66 and 83 ticks, where the rider is
 * plainly what sets the dwell.
 *
 * CITY IS THE SECOND `false`, and for the same geometric reason rather than by
 * inheritance: its hospital is a band at the first content column and its kerb is
 * the lane tile one step from that band's own door, which is Campus's arrangement
 * in City's words. The measurement is the case itself, which asserts BOTH halves
 * of this row - `riderBound - kerbTick < 40`, so the rider asks for less than the
 * floor, and the floor as observed at 41 ticks. The tick numbers above are
 * Campus's own and are not claimed of City; what the row says of City is the
 * regime, and the case is what checks it.
 *
 * A TABLE RATHER THAN A LOOSENED BOUND, for the reason the other two exist. The
 * guard on those cases is `minimumDwell > 41`, and 41 is exactly what a vehicle
 * that DROPPED its riders is observed at - so relaxing it to admit Campus would
 * admit the implementation the case exists to reject. And the regime may not be
 * read off the measured dwell either: a bug that shortened the wait would flip
 * the case into the other regime and pass. So it is declared here, and both
 * regimes assert their own premise as an observation - see the cases - which
 * makes this table something the scene confirms rather than something a fixture
 * assumes.
 *
 * WHAT THIS TABLE IS ABOUT, STATED NARROWLY - the first wording of this comment
 * claimed more than the measurement, so here is the narrow one. It is about the
 * WARD'S RIDER: both cases that read it watch an agent on its way to a bed, and
 * Campus's sick bay is the room whose kerb is a step from its own door. Nothing
 * here says Campus cannot see a vehicle wait - its POLICE CAR has a late rider
 * and pins the wait exactly as the other views do, measured by deleting the rider
 * check in `advanceVehicle`: ten cases red, one of them Campus's own police-car
 * case.
 *
 * AND IT IS NOT A CLAIM ABOUT THE SPRITE, nor about inheritance. The first of
 * the two cases watches a FIRE ENGINE that has replaced the ambulance and
 * INHERITED its riders, so "ambulance" in this constant's name is the trigger
 * and the room, not what is drawn at the kerb.
 *
 * Inheritance is the sharper one, and the SECOND wording of this comment was
 * wrong about it too. It said the transfer was still witnessed in Campus by
 * `sawInheritedRiderAway` and the settled tick. It is not, and the way to find
 * that out was to run it rather than to read it.
 *
 * MEASURED. Drop the inherited riders at the point they are transferred -
 * `forAgentIds: [agentId]` in `spawnVehicleFor` - and the case reds in exactly
 * three views: `expected 41 to be greater than or equal to 120`, `to 66` and
 * `to 83`, which are floor, towers and building. Campus stays GREEN. Nothing in
 * the Campus branch is watching the vehicle's rider list: `awayAgentIds` is
 * built from `character.seated`, and an agent walks to its bed and settles
 * whether or not a vehicle claims to be carrying it. So with the floor
 * governing, the correct engine and the rider-dropping one both leave at 41.
 *
 * WHAT CAMPUS'S BRANCH ACTUALLY PINS, then: the FLOOR-DOMINATED REGIME. Its
 * premise is that the rider bound comes in under the floor - `riderBound -
 * kerbTick < 40`, which is also what the sibling case asserts - and its
 * conclusion is the floor as OBSERVED, 41 ticks at the kerb. That the patient is
 * in bed before the engine arrives is reported history from the measurement that
 * chose this row, not something either line checks: `< 40` is satisfied by a
 * rider that settles three ticks AFTER the kerb tick, which is exactly what the
 * sibling fixture does. RIDER TRANSFER is
 * witnessed only by the `true` views, on `minimumDwell > 41` - the dwell IS
 * their instrument, and Campus asserts that same 41 as its expected value, so
 * the instrument cannot exist there. The limit is the whole Campus case for
 * that mutant, not just one assertion in it.
 *
 * So the row says which of the three bounds does the waiting, and nothing about
 * whether riders are carried. Widening it to another vehicle needs that
 * vehicle's own measurement, and any claim that a `false` view witnesses a
 * transfer needs the mutant above to red there.
 */
export const AMBULANCE_RIDER_SETS_THE_DWELL: Readonly<
  Record<OfficeViewId, boolean>
> = {
  floor: true,
  towers: true,
  building: true,
  // No road, no vehicle: these cases never run here at all.
  "mission-control": false,
  // Both districted views: the ward is a band at the lane, so the floor governs.
  campus: false,
  city: false,
};

/** The four rooms every enrolled storey owes, in no particular order. */
export const CIVIC_KINDS: ReadonlyArray<OfficeCivicKind> = [
  "infirmary",
  "waiting-room",
  "help-desk",
  "archive",
];
