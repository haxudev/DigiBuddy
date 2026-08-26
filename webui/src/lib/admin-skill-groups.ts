export type AdminCatalogueSkill = {
  name: string;
  description: string;
  source: "packaged" | "deployed" | "";
  enabled: boolean;
  availability?: "builtin" | "command" | "hidden" | "";
};

export type AdminDeployedSkill = {
  name: string;
  description: string;
  enabled: boolean;
};

export type SkillToggleRoute = "/api/admin/skill-policy" | "/api/admin/skills";

export type PackagedSkillRow = {
  name: string;
  description: string;
  enabled: boolean;
  toggleRoute: "/api/admin/skill-policy";
  /**
   * How the skill is reached, so an administrator can tell an absent menu row
   * from a broken one.
   *
   * A `builtin` skill is enabled and working while never appearing in the chat
   * menu, and without this the console would show it as ordinary and leave the
   * missing `/` command looking like a fault.
   */
  availability: "builtin" | "command" | "hidden" | "";
};

export type CustomSkillRow<T extends AdminDeployedSkill = AdminDeployedSkill> = T & {
  toggleRoute: "/api/admin/skills";
};

export type AdminSkillGroups<T extends AdminDeployedSkill = AdminDeployedSkill> = {
  packaged: PackagedSkillRow[];
  custom: CustomSkillRow<T>[];
  counts: {
    packaged: number;
    packagedOff: number;
    custom: number;
    customOff: number;
  };
};

export type AssignableCatalogue = {
  skills: string[];
  tools: string[];
  mcp_servers: string[];
};

export type AssignableDeployedCapability = {
  name: string;
  kind: "skill" | "tool" | "mcp_server";
  enabled: boolean;
  sha256: string;
  approved_sha256: string;
};

export function buildAssignableCapabilities(
  catalogue: AssignableCatalogue,
  deployed: AssignableDeployedCapability[],
): AssignableCatalogue {
  // A newly deployed capability may be assigned before the runtime has had a
  // chance to republish its catalogue. Executable artifacts do not count until
  // the administrator has approved the exact bytes now in the store.
  const active = deployed.filter(
    (entry) =>
      entry.enabled &&
      (entry.kind === "skill" || entry.approved_sha256 === entry.sha256),
  );
  const names = (kind: AssignableDeployedCapability["kind"], existing: string[]) =>
    [
      ...new Set([
        ...existing,
        ...active.filter((entry) => entry.kind === kind).map((entry) => entry.name),
      ]),
    ].sort();

  return {
    skills: names("skill", catalogue.skills),
    tools: names("tool", catalogue.tools),
    mcp_servers: names("mcp_server", catalogue.mcp_servers),
  };
}

export function skillToggleRoute(source: "packaged" | "deployed"): SkillToggleRoute {
  return source === "packaged" ? "/api/admin/skill-policy" : "/api/admin/skills";
}

export function buildAdminSkillGroups<T extends AdminDeployedSkill>(
  inventory: AdminCatalogueSkill[],
  deployed: T[],
  disabledPackaged: string[],
): AdminSkillGroups<T> {
  const disabled = new Set(disabledPackaged);
  const packaged = inventory
    .filter((entry) => entry.source === "packaged")
    .map((entry) => ({
      name: entry.name,
      description: entry.description,
      enabled: !disabled.has(entry.name),
      toggleRoute: skillToggleRoute("packaged") as "/api/admin/skill-policy",
      availability: entry.availability ?? "",
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
  const custom = deployed
    .map((entry) => ({
      ...entry,
      toggleRoute: skillToggleRoute("deployed") as "/api/admin/skills",
    }))
    .sort((left, right) => left.name.localeCompare(right.name));

  return {
    packaged,
    custom,
    counts: {
      packaged: packaged.length,
      packagedOff: packaged.filter((entry) => !entry.enabled).length,
      custom: custom.length,
      customOff: custom.filter((entry) => !entry.enabled).length,
    },
  };
}
