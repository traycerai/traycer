import { describe, expect, it } from "vitest";
import { hostRpcRegistry } from "@traycer/protocol/host/registry";
import {
  grantEpicAccessRequestSchema,
  grantEpicAccessResponseSchema,
  batchUpdateEpicRolesRequestSchema,
  batchUpdateEpicRolesResponseSchema,
  revokeEpicCollaboratorRequestSchema,
  revokeEpicCollaboratorResponseSchema,
  listEpicCollaboratorsResponseSchema,
} from "@traycer/protocol/host/epic/unary-schemas";

/**
 * Verifies that the three collaborator mutation contracts in hostRpcRegistry
 * use the correct canonical schemas and that grant/batchUpdate/revokeCollaborator
 * response schemas are the same instance as listEpicCollaboratorsResponseSchema.
 */
describe("epic collaborator mutation schemas", () => {
  it("epic.grantAccess uses grantEpicAccessRequestSchema", () => {
    const contract =
      hostRpcRegistry["epic.grantAccess"][1].versions[0].contract;
    expect(contract.requestSchema).toBe(grantEpicAccessRequestSchema);
  });

  it("epic.grantAccess response is listEpicCollaboratorsResponseSchema", () => {
    const contract =
      hostRpcRegistry["epic.grantAccess"][1].versions[0].contract;
    expect(contract.responseSchema).toBe(listEpicCollaboratorsResponseSchema);
    expect(contract.responseSchema).toBe(grantEpicAccessResponseSchema);
  });

  it("epic.batchUpdateRoles uses batchUpdateEpicRolesRequestSchema", () => {
    const contract =
      hostRpcRegistry["epic.batchUpdateRoles"][1].versions[0].contract;
    expect(contract.requestSchema).toBe(batchUpdateEpicRolesRequestSchema);
  });

  it("epic.batchUpdateRoles response is listEpicCollaboratorsResponseSchema", () => {
    const contract =
      hostRpcRegistry["epic.batchUpdateRoles"][1].versions[0].contract;
    expect(contract.responseSchema).toBe(listEpicCollaboratorsResponseSchema);
    expect(contract.responseSchema).toBe(batchUpdateEpicRolesResponseSchema);
  });

  it("epic.revokeCollaborator uses revokeEpicCollaboratorRequestSchema", () => {
    const contract =
      hostRpcRegistry["epic.revokeCollaborator"][1].versions[0].contract;
    expect(contract.requestSchema).toBe(revokeEpicCollaboratorRequestSchema);
  });

  it("epic.revokeCollaborator response is listEpicCollaboratorsResponseSchema", () => {
    const contract =
      hostRpcRegistry["epic.revokeCollaborator"][1].versions[0].contract;
    expect(contract.responseSchema).toBe(listEpicCollaboratorsResponseSchema);
    expect(contract.responseSchema).toBe(revokeEpicCollaboratorResponseSchema);
  });
});
