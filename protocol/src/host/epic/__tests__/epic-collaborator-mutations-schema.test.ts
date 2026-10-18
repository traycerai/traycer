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
  listEpicCollaboratorsResponseSchemaPre11,
} from "@traycer/protocol/host/epic/unary-schemas";

/**
 * Verifies that the three collaborator mutation contracts in hostRpcRegistry
 * use the correct canonical schemas: at 1.1 the grant/batchUpdate/
 * revokeCollaborator responses are the same instance as
 * listEpicCollaboratorsResponseSchema (the list a client caches), and at 1.0
 * the hand-frozen released list, the same instance as
 * `epic.listCollaborators@1.0` answers.
 */
describe("epic collaborator mutation schemas", () => {
  it("epic.grantAccess uses grantEpicAccessRequestSchema", () => {
    const contract =
      hostRpcRegistry["epic.grantAccess"][1].versions[0].contract;
    expect(contract.requestSchema).toBe(grantEpicAccessRequestSchema);
  });

  it("epic.grantAccess@1.1 response is listEpicCollaboratorsResponseSchema", () => {
    const contract =
      hostRpcRegistry["epic.grantAccess"][1].versions[1].contract;
    expect(contract.responseSchema).toBe(listEpicCollaboratorsResponseSchema);
    expect(contract.responseSchema).toBe(grantEpicAccessResponseSchema);
  });

  it("epic.grantAccess@1.0 response is the frozen released list", () => {
    const contract =
      hostRpcRegistry["epic.grantAccess"][1].versions[0].contract;
    expect(contract.responseSchema).toBe(
      listEpicCollaboratorsResponseSchemaPre11,
    );
    expect(contract.responseSchema).toBe(
      hostRpcRegistry["epic.listCollaborators"][1].versions[0].contract
        .responseSchema,
    );
  });

  it("epic.batchUpdateRoles uses batchUpdateEpicRolesRequestSchema", () => {
    const contract =
      hostRpcRegistry["epic.batchUpdateRoles"][1].versions[0].contract;
    expect(contract.requestSchema).toBe(batchUpdateEpicRolesRequestSchema);
  });

  it("epic.batchUpdateRoles@1.1 response is listEpicCollaboratorsResponseSchema", () => {
    const contract =
      hostRpcRegistry["epic.batchUpdateRoles"][1].versions[1].contract;
    expect(contract.responseSchema).toBe(listEpicCollaboratorsResponseSchema);
    expect(contract.responseSchema).toBe(batchUpdateEpicRolesResponseSchema);
  });

  it("epic.batchUpdateRoles@1.0 response is the frozen released list", () => {
    const contract =
      hostRpcRegistry["epic.batchUpdateRoles"][1].versions[0].contract;
    expect(contract.responseSchema).toBe(
      listEpicCollaboratorsResponseSchemaPre11,
    );
    expect(contract.responseSchema).toBe(
      hostRpcRegistry["epic.listCollaborators"][1].versions[0].contract
        .responseSchema,
    );
  });

  it("epic.revokeCollaborator uses revokeEpicCollaboratorRequestSchema", () => {
    const contract =
      hostRpcRegistry["epic.revokeCollaborator"][1].versions[0].contract;
    expect(contract.requestSchema).toBe(revokeEpicCollaboratorRequestSchema);
  });

  it("epic.revokeCollaborator@1.1 response is listEpicCollaboratorsResponseSchema", () => {
    const contract =
      hostRpcRegistry["epic.revokeCollaborator"][1].versions[1].contract;
    expect(contract.responseSchema).toBe(listEpicCollaboratorsResponseSchema);
    expect(contract.responseSchema).toBe(revokeEpicCollaboratorResponseSchema);
  });

  it("epic.revokeCollaborator@1.0 response is the frozen released list", () => {
    const contract =
      hostRpcRegistry["epic.revokeCollaborator"][1].versions[0].contract;
    expect(contract.responseSchema).toBe(
      listEpicCollaboratorsResponseSchemaPre11,
    );
    expect(contract.responseSchema).toBe(
      hostRpcRegistry["epic.listCollaborators"][1].versions[0].contract
        .responseSchema,
    );
  });
});
