/**
 * The collaborator who owns a shared chat, as copy names them: by name, or
 * "another collaborator" while the task's collaborator list has not named
 * them (`useCollaboratorDisplayName` reads `null`). Never an id.
 */
export function collaboratorReference(name: string | null): string {
  return name ?? "another collaborator";
}

/** That collaborator's machine: "<name>'s computer". */
export function collaboratorComputer(name: string | null): string {
  return `${collaboratorReference(name)}'s computer`;
}
