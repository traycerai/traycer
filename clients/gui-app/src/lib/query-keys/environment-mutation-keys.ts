/**
 * Write keys for the Personal settings the host forwards to the person's
 * environment (`environment.*`): agent definitions and machine setup, plus the
 * Tracy Bots main bot (`environment.setMainBot`), and the environments
 * redesign's writes: the move, a team configuration's items and policy,
 * members, and the retrospective sheet's held items.
 */
export const environmentMutationKeys = {
  agentDefinitionsPut: () => ["environment.agentDefinitions.put"] as const,
  agentDefinitionsDelete: () =>
    ["environment.agentDefinitions.delete"] as const,
  setupPut: () => ["environment.setup.put"] as const,
  setupRetry: () => ["environment.setup.retry"] as const,
  moveDiagnosticsExport: () => ["environment.move.diagnosticsExport"] as const,
  undo: () => ["environment.undo"] as const,
  localOverrideSet: () => ["config.env.localOverride.set"] as const,
  localOverrideClear: () => ["config.env.localOverride.clear"] as const,
  ownSlotsChange: () => ["environment.ownSlots.change"] as const,
  remoteAccessSet: () => ["host.remoteAccess.set"] as const,
  remoteAccessTurnOn: () => ["hosts.remoteAccess.put"] as const,
  setMainBot: () => ["environment.setMainBot"] as const,
  moveStart: () => ["environment.move.start"] as const,
  moveStop: () => ["environment.move.stop"] as const,
  configurationItemsPut: () => ["environment.configuration.items.put"] as const,
  configurationItemsDelete: () =>
    ["environment.configuration.items.delete"] as const,
  configurationMcpServersPut: () =>
    ["environment.configuration.mcpServers.put"] as const,
  configurationMcpServersDelete: () =>
    ["environment.configuration.mcpServers.delete"] as const,
  configurationMcpServersSetEnabled: () =>
    ["environment.configuration.mcpServers.setEnabled"] as const,
  configurationSkillsUpload: () =>
    ["environment.configuration.skills.upload"] as const,
  configurationSkillsRemove: () =>
    ["environment.configuration.skills.remove"] as const,
  configurationSkillsSetProviders: () =>
    ["environment.configuration.skills.setProviders"] as const,
  configurationSkillsSetPolicy: () =>
    ["environment.configuration.skills.setPolicy"] as const,
  configurationSkillsUpdate: () =>
    ["environment.configuration.skills.update"] as const,
  configurationSkillsRestoreBundled: () =>
    ["environment.configuration.skills.restoreBundled"] as const,
  configurationSkillsImport: () =>
    ["environment.configuration.skills.import"] as const,
  configurationSkillsCheckUpdates: () =>
    ["environment.configuration.skills.state", "refresh"] as const,
  configurationPolicyPut: () =>
    ["environment.configuration.policy.put"] as const,
  membersInvite: () => ["environment.members.invite"] as const,
  membersSetRole: () => ["environment.members.setRole"] as const,
  membersRemove: () => ["environment.members.remove"] as const,
  membersNoticeSeen: () => ["environment.members.noticeSeen"] as const,
  invitationsAccept: () => ["environment.invitations.accept"] as const,
  reviewApplyChoice: () => ["environment.review.applyChoice"] as const,
  teamReviewApplyChoice: (environmentId: string, viewerId: string) =>
    ["environment.review.applyChoice", environmentId, viewerId] as const,
  reviewRecord: () => ["environment.review.record"] as const,
  providersSetColor: () => ["auth", "profile-record-color"] as const,
  providersSetEnabled: () => ["auth", "profile-record-enabled"] as const,
  providersSignOut: () => ["auth", "profile-record-sign-out"] as const,
  providersRemove: () => ["auth", "profile-record-remove"] as const,
  providersRename: () => ["auth", "profile-record-name"] as const,
  providersReplaceKey: () => ["environment.providers.replaceKey"] as const,
  configurationGuideSet: () => ["environment.configuration.guide.set"] as const,
  configurationGuideReset: () =>
    ["environment.configuration.guide.reset"] as const,
};
