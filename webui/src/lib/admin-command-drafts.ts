import type { CommandOverride, SkillCommand } from "./skill-commands.ts";

export type CommandDraft = CommandOverride & {
  local?: boolean;
  localId?: string;
  orderInput?: string;
};

export function createLocalCommandDraft(
  id = crypto.randomUUID(),
): CommandDraft {
  return {
    name: "",
    title: "",
    description: "",
    hint: "",
    enabled: true,
    order: 0,
    skills: [],
    local: true,
    localId: id,
  };
}

export function commandDraftKey(
  draft: CommandDraft,
  resolved?: Pick<SkillCommand, "name">,
): string {
  if (draft.local) return `local:${draft.localId}`;
  return `command:${draft.name || resolved?.name}`;
}

export function mergeCommandDraftsAfterRefresh(
  current: CommandDraft[],
  refreshed: CommandOverride[],
  dirtyNames: Set<string>,
  dropNames = new Set<string>(),
): CommandDraft[] {
  const currentByName = new Map(
    current
      .filter((draft) => !draft.local && draft.name)
      .map((draft) => [draft.name, draft]),
  );
  const next = refreshed.map((serverDraft) => {
    const dirty = currentByName.get(serverDraft.name);
    return dirtyNames.has(serverDraft.name) && dirty
      ? { ...serverDraft, ...dirty }
      : serverDraft;
  });
  const names = new Set(next.map((draft) => draft.name));
  for (const draft of current) {
    if (dropNames.has(draft.name)) continue;
    if (draft.local) {
      next.push(draft);
      continue;
    }
    if (dirtyNames.has(draft.name) && !names.has(draft.name)) {
      next.push(draft);
    }
  }
  return next;
}

export function parseCommandOrder(
  value: string,
  fallback: number,
): { order: number; orderInput: string } {
  const parsed = Number(value);
  return {
    order: Number.isFinite(parsed) ? parsed : fallback,
    orderInput: value,
  };
}
