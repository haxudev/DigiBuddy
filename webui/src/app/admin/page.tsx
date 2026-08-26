"use client";

import {
  type FormEvent,
  useCallback,
  useEffect,
  useState,
} from "react";
import Link from "next/link";
import {
  commandDraftKey,
  createLocalCommandDraft,
  mergeCommandDraftsAfterRefresh,
  parseCommandOrder,
  type CommandDraft,
} from "@/lib/admin-command-drafts";
import {
  CREDENTIAL_SLOTS,
  type CredentialStatus,
} from "@/lib/credentials";
import {
  buildAdminSkillGroups,
  buildAssignableCapabilities,
} from "@/lib/admin-skill-groups";
import type { CommandOverride, SkillCommand } from "@/lib/skill-commands";
import styles from "./admin.module.css";

type CatalogueSkill = {
  name: string;
  description: string;
  source: "packaged" | "deployed" | "";
  enabled: boolean;
  availability?: "builtin" | "command" | "hidden" | "";
};

type Catalogue = {
  skills: string[];
  tools: string[];
  mcp_servers: string[];
  skill_entries: CatalogueSkill[];
};

type Models = {
  model: string;
  endpoint: string;
  provider: string;
  reasoning_effort: string;
  api_key?: string;
  api_key_set?: boolean;
};

type McpServer = {
  url: string;
  command?: string;
  args?: string[];
  enabled: boolean;
  bearer_token_env_var: string;
  description: string;
};

type Profile = {
  name: string;
  display_name: string;
  description: string;
  persona: string;
  skills: string[] | null;
  tools: string[] | null;
  mcp_servers: string[] | null;
  model: string;
  reasoning_effort: string;
};

type DeployedSkill = {
  name: string;
  kind: "skill" | "tool" | "mcp_server";
  version: string;
  description: string;
  sha256: string;
  size: number;
  enabled: boolean;
  /** The exact bytes approved to execute; empty means deployed but inert. */
  approved_sha256: string;
  approved_at: string;
  approved_by: string;
  declaration: Record<string, unknown>;
  uploaded_at: string;
  uploaded_by: string;
  source: string;
};

/** What an archive would deploy, before anything is written. */
type CapabilityKind = "skill" | "tool" | "mcp_server";

type BundlePreview = {
  layout: "single" | "manifest" | "discovered";
  notes: string[];
  /** The exact archive this listing describes; deployment must present it. */
  archive_sha256: string;
  skills: {
    name: string;
    kind: CapabilityKind;
    description: string;
    size: number;
    sha256: string;
    entries: string[];
    declaration: Record<string, unknown> | null;
  }[];
};

const KINDS: Record<CapabilityKind, string> = {
  skill: "skill",
  tool: "tool — code the agent may run",
  mcp_server: "MCP server — a command the runtime starts with Codex",
};

/** A previewed archive waiting for the administrator to confirm it. */
type Pending = { preview: BundlePreview; file?: File; source?: string };

const LAYOUTS: Record<BundlePreview["layout"], string> = {
  single: "a single skill, deployed as uploaded",
  manifest: "described by digibuddy-skills.json",
  discovered: "discovered from the archive's layout",
};

type NamedServer = McpServer & { name: string };

const EFFORTS = ["low", "medium", "high", "xhigh", "max"];

const emptyModels: Models = {
  model: "",
  endpoint: "",
  provider: "",
  reasoning_effort: "",
};

const emptyProfile: Profile = {
  name: "",
  display_name: "",
  description: "",
  persona: "",
  skills: null,
  tools: null,
  mcp_servers: null,
  model: "",
  reasoning_effort: "",
};

type ConfigPayload = {
  "models.json"?: Models;
  "mcp.json"?: { servers?: Record<string, McpServer> };
  "profiles.json"?: { profiles?: Profile[] };
  "catalogue.json"?: Partial<Catalogue>;
  "skills.json"?: { skills?: DeployedSkill[] };
  /** What each document looked like when it was loaded, so a save can be conditional. */
  revisions?: Record<string, string>;
};

type CommandPayload = {
  commands: CommandOverride[];
  revision?: string;
};

type SkillPolicyPayload = {
  disabled: string[];
  revision?: string;
};

type ResolvedCommandPayload = {
  commands: SkillCommand[];
};

type AdminState =
  | { status: "checking"; name: "" }
  | { status: "locked"; name: "" }
  | { status: "authenticated"; name: string };

function AdminLoginMask({
  checking,
  onAuthenticated,
}: {
  checking: boolean;
  onAuthenticated: (name: string) => void;
}) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function signIn(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/admin/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload.error || "Administrator sign-in failed.");
      }
      setPassword("");
      onAuthenticated(String(payload.name ?? username));
    } catch (signInError) {
      setError(
        signInError instanceof Error
          ? signInError.message
          : "Administrator sign-in failed.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className={styles.loginShell}>
      <div className={styles.loginBackdrop} aria-hidden="true">
        <span>GTMBuddy</span>
        <strong>Runtime administration</strong>
      </div>
      <section className={styles.loginMask} aria-busy={checking}>
        <div className={styles.loginMark}>⌁</div>
        <p className={styles.eyebrow}>Restricted console</p>
        <h1>Administrator sign in</h1>
        <p className={styles.loginHint}>
          Use the dedicated administrator credentials for this runtime.
        </p>
        {checking ? (
          <p className={styles.loginStatus}>Checking administrator session…</p>
        ) : (
          <form onSubmit={signIn}>
            <label>
              Username
              <input
                autoComplete="username"
                autoFocus
                value={username}
                onChange={(event) => setUsername(event.target.value)}
              />
            </label>
            <label>
              Password
              <input
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
            </label>
            {error && (
              <div className={styles.error} role="alert">
                {error}
              </div>
            )}
            <button
              type="submit"
              disabled={busy || !username.trim() || !password}
            >
              {busy ? "Signing in…" : "Unlock administration"}
            </button>
          </form>
        )}
        <Link href="/">Back to chat</Link>
      </section>
    </main>
  );
}

async function fetchConfig(): Promise<ConfigPayload> {
  const response = await fetch("/api/admin/config", { cache: "no-store" });
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.error || "Unable to load configuration.");
  }
  return payload as ConfigPayload;
}

async function fetchCommands(): Promise<{
  overrides: CommandOverride[];
  resolved: SkillCommand[];
  revision?: string;
}> {
  const [adminResponse, resolvedResponse] = await Promise.all([
    fetch("/api/admin/commands", { cache: "no-store" }),
    fetch("/api/commands", { cache: "no-store" }),
  ]);
  const adminPayload = (await adminResponse.json()) as CommandPayload & {
    error?: string;
  };
  const resolvedPayload = (await resolvedResponse.json()) as ResolvedCommandPayload & {
    error?: string;
  };
  if (!adminResponse.ok) {
    throw new Error(adminPayload.error || "Unable to load command overrides.");
  }
  if (!resolvedResponse.ok) {
    throw new Error(resolvedPayload.error || "Unable to load commands.");
  }
  return {
    overrides: adminPayload.commands ?? [],
    resolved: resolvedPayload.commands ?? [],
    revision: adminPayload.revision,
  };
}

async function fetchSkillPolicy(): Promise<SkillPolicyPayload> {
  const response = await fetch("/api/admin/skill-policy", { cache: "no-store" });
  const payload = (await response.json()) as SkillPolicyPayload & { error?: string };
  if (!response.ok) {
    throw new Error(payload.error || "Unable to load packaged skill policy.");
  }
  return { disabled: payload.disabled ?? [], revision: payload.revision };
}

/** `null` means "every packaged capability"; toggling one entry starts a restriction. */
function toggle(selection: string[] | null, entry: string, all: string[]): string[] {
  const current = selection ?? all;
  return current.includes(entry)
    ? current.filter((item) => item !== entry)
    : [...current, entry];
}

function Selector({
  label,
  available,
  selection,
  onChange,
}: {
  label: string;
  available: string[];
  selection: string[] | null;
  onChange: (next: string[] | null) => void;
}) {
  if (available.length === 0) return null;
  return (
    <div>
      <div className={styles.rowHeader}>
        <strong>{label}</strong>
        <button
          className={styles.remove}
          type="button"
          onClick={() => onChange(selection === null ? [] : null)}
        >
          {selection === null ? "Restrict" : "Allow all"}
        </button>
      </div>
      <div className={styles.checks}>
        {available.map((entry) => (
          <label key={entry}>
            <input
              type="checkbox"
              checked={selection === null || selection.includes(entry)}
              onChange={() => onChange(toggle(selection, entry, available))}
            />
            {entry}
          </label>
        ))}
      </div>
    </div>
  );
}

/**
 * Write-only credential entry.
 *
 * Values are never read back, so this shows which slots are set and offers to
 * replace or remove one. That is the whole interaction: an administrator who
 * needs a different secret rotates it rather than inspecting the current one.
 */
function Credentials({
  profile,
  statuses,
  busy,
  onChange,
}: {
  profile: string;
  statuses: CredentialStatus[];
  busy: boolean;
  onChange: (slot: string, action: "rotate" | "clear", value: string) => void;
}) {
  const [slot, setSlot] = useState<string>(CREDENTIAL_SLOTS[0]);
  const [value, setValue] = useState("");
  const bound = statuses.filter((entry) => entry.profile === profile);

  return (
    <div className={styles.field}>
      <span className={styles.label}>Credentials</span>
      <p className={styles.hint}>
        Handed only to this profile&apos;s agent process. Values are write-only:
        rotate to replace one, clear to remove it.
      </p>
      {bound.length > 0 && (
        <ul className={styles.chips}>
          {bound.map((entry) => (
            <li key={entry.slot}>
              {entry.slot} · set
              <button
                type="button"
                disabled={busy}
                aria-label={`Clear ${entry.slot}`}
                onClick={() => onChange(entry.slot, "clear", "")}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className={styles.row}>
        <select
          aria-label="Credential slot"
          value={slot}
          onChange={(event) => setSlot(event.target.value)}
        >
          {CREDENTIAL_SLOTS.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
        <input
          type="password"
          autoComplete="off"
          placeholder="New value"
          value={value}
          onChange={(event) => setValue(event.target.value)}
        />
        <button
          type="button"
          disabled={busy || !value.trim() || !profile}
          onClick={() => {
            onChange(slot, "rotate", value);
            setValue("");
          }}
        >
          Rotate
        </button>
      </div>
    </div>
  );
}

export default function Admin() {
  const [admin, setAdmin] = useState<AdminState>({
    status: "checking",
    name: "",
  });
  const [tab, setTab] = useState<
    "models" | "mcp" | "skills" | "commands" | "profiles"
  >("models");
  const [catalogue, setCatalogue] = useState<Catalogue>({
    skills: [],
    tools: [],
    mcp_servers: [],
    skill_entries: [],
  });
  const [models, setModels] = useState<Models>(emptyModels);
  const [servers, setServers] = useState<NamedServer[]>([]);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [skills, setSkills] = useState<DeployedSkill[]>([]);
  const [disabledPackagedSkills, setDisabledPackagedSkills] = useState<string[]>([]);
  const [skillPolicyRevision, setSkillPolicyRevision] = useState<string | undefined>();
  const [commandDrafts, setCommandDrafts] = useState<CommandDraft[]>([]);
  const [commandOverrides, setCommandOverrides] = useState<CommandOverride[]>([]);
  const [commandDirtyNames, setCommandDirtyNames] = useState<Set<string>>(
    () => new Set(),
  );
  const [commandRevision, setCommandRevision] = useState<string | undefined>();
  const [resolvedCommands, setResolvedCommands] = useState<SkillCommand[]>([]);
  const [allowedHosts, setAllowedHosts] = useState<string[]>([]);
  const [source, setSource] = useState("");
  const [revisions, setRevisions] = useState<Record<string, string>>({});
  const [credentials, setCredentials] = useState<CredentialStatus[]>([]);
  const [pending, setPending] = useState<Pending | null>(null);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    return Promise.all([fetchConfig(), fetchCommands(), fetchSkillPolicy()]).then(
      ([payload, commandPayload, skillPolicy]) => {
        setError("");
        setModels({ ...emptyModels, ...(payload["models.json"] ?? {}) });
        setServers(
          Object.entries(payload["mcp.json"]?.servers ?? {}).map(
            ([name, server]) => ({ name, ...server }),
          ),
        );
        setProfiles(payload["profiles.json"]?.profiles ?? []);
        setSkills(payload["skills.json"]?.skills ?? []);
        setRevisions(payload.revisions ?? {});
        setCatalogue({
          skills: [],
          tools: [],
          mcp_servers: [],
          skill_entries: [],
          ...(payload["catalogue.json"] ?? {}),
        });
        setCommandDrafts(commandPayload.overrides);
        setCommandOverrides(commandPayload.overrides);
        setCommandDirtyNames(new Set());
        setCommandRevision(commandPayload.revision);
        setResolvedCommands(commandPayload.resolved);
        setDisabledPackagedSkills(skillPolicy.disabled);
        setSkillPolicyRevision(skillPolicy.revision);
      },
      (loadError: unknown) => {
        setError(loadError instanceof Error ? loadError.message : "Unable to load.");
      },
    );
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/admin/session", {
      cache: "no-store",
      signal: controller.signal,
    })
      .then(async (response) => {
        const payload = await response.json();
        setAdmin(
          response.ok && payload.authenticated
            ? {
                status: "authenticated",
                name: String(payload.name ?? "administrator"),
              }
            : { status: "locked", name: "" },
        );
      })
      .catch((sessionError) => {
        if (
          sessionError instanceof DOMException &&
          sessionError.name === "AbortError"
        ) {
          return;
        }
        setAdmin({ status: "locked", name: "" });
      });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (admin.status === "authenticated") void load();
  }, [admin.status, load]);

  // Whether importing from a URL is offered at all is a deployment decision, so
  // ask the server rather than guessing.
  useEffect(() => {
    if (admin.status !== "authenticated") return;
    fetch("/api/admin/credentials", { cache: "no-store" })
      .then((response) => (response.ok ? response.json() : { credentials: [] }))
      .then((payload) => setCredentials(payload.credentials ?? []))
      .catch(() => setCredentials([]));
  }, [admin.status]);

  useEffect(() => {
    if (admin.status !== "authenticated") return;
    fetch("/api/admin/skills/preview", { cache: "no-store" })
      .then((response) => (response.ok ? response.json() : { allowed_hosts: [] }))
      .then((payload) => setAllowedHosts(payload.allowed_hosts ?? []))
      .catch(() => setAllowedHosts([]));
  }, [admin.status]);

  async function signOut() {
    await fetch("/api/admin/session", { method: "DELETE" });
    setAdmin({ status: "locked", name: "" });
    setModels(emptyModels);
    setServers([]);
    setProfiles([]);
    setSkills([]);
    setDisabledPackagedSkills([]);
    setSkillPolicyRevision(undefined);
    setCommandDrafts([]);
    setCommandOverrides([]);
    setCommandDirtyNames(new Set());
    setCommandRevision(undefined);
    setResolvedCommands([]);
    setCredentials([]);
  }

  async function save(document: string, value: unknown) {
    setBusy(true);
    setError("");
    setStatus("");
    try {
      const response = await fetch("/api/admin/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        // The revision makes the save conditional: if another administrator
        // saved in the meantime, this reports it instead of discarding theirs.
        body: JSON.stringify({ document, value, revision: revisions[document] }),
      });
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(
          response.status === 409
            ? "Someone else changed this while you were editing. Reload to see their version."
            : payload.error || "Unable to save.",
        );
      }
      setStatus(`Saved ${document}. It applies from the next turn.`);
      await load();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Unable to save.");
    } finally {
      setBusy(false);
    }
  }

  async function callSkills(
    init: RequestInit,
    failureMessage: string,
    query = "",
  ) {
    setBusy(true);
    setError("");
    setStatus("");
    try {
      const response = await fetch(`/api/admin/skills${query}`, init);
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || failureMessage);
      setSkills(payload.skills ?? []);
      setStatus("Skills updated. They apply from the next turn.");
      await load();
    } catch (callError) {
      setError(callError instanceof Error ? callError.message : failureMessage);
    } finally {
      setBusy(false);
    }
  }

  async function togglePackagedSkill(name: string, enabled: boolean) {
    setBusy(true);
    setError("");
    setStatus("");
    try {
      const response = await fetch("/api/admin/skill-policy", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, enabled, revision: skillPolicyRevision }),
      });
      const payload = (await response.json()) as SkillPolicyPayload & { error?: string };
      if (!response.ok) {
        throw new Error(
          response.status === 409
            ? "Someone else changed packaged skill policy while you were editing. Reload to see their version."
            : payload.error || "Unable to update the packaged skill.",
        );
      }
      setDisabledPackagedSkills(payload.disabled ?? []);
      setSkillPolicyRevision(payload.revision);
      setStatus("Skills updated. They apply from the next turn.");
      await load();
    } catch (callError) {
      setError(
        callError instanceof Error
          ? callError.message
          : "Unable to update the packaged skill.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function refreshCommands(options?: {
    dirtyNames?: Set<string>;
    dropNames?: Set<string>;
  }) {
    const payload = await fetchCommands();
    const dirtyNames = options?.dirtyNames ?? commandDirtyNames;
    const dropNames = options?.dropNames ?? new Set<string>();
    // A refresh is authoritative for clean rows, but not for edits that only
    // exist in this browser yet; otherwise saving one row would silently erase
    // another row the administrator has not had a chance to submit.
    setCommandDrafts((current) =>
      mergeCommandDraftsAfterRefresh(
        current,
        payload.overrides,
        dirtyNames,
        dropNames,
      ),
    );
    setCommandOverrides(payload.overrides);
    setCommandRevision(payload.revision);
    setResolvedCommands(payload.resolved);
  }

  function updateCommandDraft(
    index: number | null,
    name: string,
    patch: Partial<CommandDraft>,
  ) {
    setCommandDirtyNames((current) => {
      const next = new Set(current);
      next.add(patch.name ?? name);
      return next;
    });
    setCommandDrafts((current) => {
      if (index !== null) {
        return current.map((command, position) =>
          position === index ? { ...command, ...patch } : command,
        );
      }
      return [...current, { name, ...patch }];
    });
  }

  function discardCommandDraft(index: number, name: string) {
    setCommandDirtyNames((current) => {
      const next = new Set(current);
      next.delete(name);
      return next;
    });
    setCommandDrafts(commandDrafts.filter((_, position) => position !== index));
  }

  async function saveCommand(command: CommandOverride) {
    setBusy(true);
    setError("");
    setStatus("");
    try {
      const body = Object.fromEntries(
        Object.entries(command).filter(
          ([key]) => !["local", "localId", "orderInput"].includes(key),
        ),
      );
      const response = await fetch("/api/admin/commands", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...body, revision: commandRevision }),
      });
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload.error || "Unable to save the command.");
      }
      setStatus(`Saved /${command.name}. It applies from the next turn.`);
      const savedName =
        typeof payload.command?.name === "string"
          ? payload.command.name
          : command.name.trim().toLowerCase();
      const nextDirty = new Set(commandDirtyNames);
      nextDirty.delete(savedName);
      nextDirty.delete(command.name);
      setCommandDirtyNames(nextDirty);
      await refreshCommands({
        dirtyNames: nextDirty,
        dropNames: new Set([savedName, command.name]),
      });
    } catch (commandError) {
      setError(
        commandError instanceof Error
          ? commandError.message
          : "Unable to save the command.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function deleteCommand(name: string) {
    setBusy(true);
    setError("");
    setStatus("");
    try {
      const query = new URLSearchParams({ name });
      if (commandRevision !== undefined) query.set("revision", commandRevision);
      const response = await fetch(
        `/api/admin/commands?${query}`,
        { method: "DELETE" },
      );
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload.error || "Unable to delete the command override.");
      }
      setStatus(payload.message || `Deleted the /${name} override.`);
      const nextDirty = new Set(commandDirtyNames);
      nextDirty.delete(name);
      setCommandDirtyNames(nextDirty);
      await refreshCommands({
        dirtyNames: nextDirty,
        dropNames: new Set([name]),
      });
    } catch (commandError) {
      setError(
        commandError instanceof Error
          ? commandError.message
          : "Unable to delete the command override.",
      );
    } finally {
      setBusy(false);
    }
  }

  /**
   * Deployment is always confirmed against a preview, because an archive can
   * yield several skills and replace existing ones, and the administrator should
   * see exactly what will change before it does.
   */
  async function preview(pendingBundle: Pick<Pending, "file" | "source">) {
    setBusy(true);
    setError("");
    setStatus("");
    setPending(null);
    try {
      let init: RequestInit;
      if (pendingBundle.file) {
        const body = new FormData();
        body.append("bundle", pendingBundle.file);
        init = { method: "POST", body };
      } else {
        init = {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ source: pendingBundle.source }),
        };
      }
      const response = await fetch("/api/admin/skills/preview", init);
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Unable to read the archive.");
      setPending({ ...pendingBundle, preview: payload as BundlePreview });
    } catch (previewError) {
      setError(
        previewError instanceof Error
          ? previewError.message
          : "Unable to read the archive.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function deploy() {
    if (!pending) return;
    setBusy(true);
    setError("");
    setStatus("");
    try {
      let response: Response;
      // The digest travels with the request, so what installs is what was read
      // above -- a URL import fetches the archive a second time.
      const previewed = pending.preview.archive_sha256;
      if (pending.file) {
        const body = new FormData();
        body.append("bundle", pending.file);
        body.append("previewed", previewed);
        response = await fetch("/api/admin/skills", { method: "POST", body });
      } else {
        response = await fetch("/api/admin/skills/import", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ source: pending.source, previewed }),
        });
      }
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Unable to deploy the archive.");
      setSkills(payload.skills ?? []);
      setPending(null);
      setSource("");
      setStatus(
        `Deployed ${payload.deployed?.length ?? 0} skill(s). They apply from the next turn.`,
      );
      await load();
    } catch (deployError) {
      setError(
        deployError instanceof Error ? deployError.message : "Unable to deploy the archive.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function changeCredential(
    profile: string,
    slot: string,
    action: "rotate" | "clear",
    value: string,
  ) {
    setBusy(true);
    setError("");
    setStatus("");
    try {
      const response = await fetch("/api/admin/credentials", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ profile, slot, action, value }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Unable to save the credential.");
      setCredentials(payload.credentials ?? []);
      setStatus(`Credential ${action === "clear" ? "cleared" : "rotated"}. It applies from the next turn.`);
    } catch (credentialError) {
      setError(
        credentialError instanceof Error
          ? credentialError.message
          : "Unable to save the credential.",
      );
    } finally {
      setBusy(false);
    }
  }

  function updateProfile(index: number, patch: Partial<Profile>) {
    setProfiles((current) =>
      current.map((profile, position) =>
        position === index ? { ...profile, ...patch } : profile,
      ),
    );
  }

  const assignable = buildAssignableCapabilities(catalogue, skills);
  const assignableSkills = assignable.skills;
  const assignableTools = assignable.tools;
  const assignableMcpServers = assignable.mcp_servers;
  const skillSources = new Map(
    catalogue.skill_entries.map((entry) => [entry.name, entry.source]),
  );
  // An empty source means the runtime did not say, which a reader should not
  // see as a claim about where the skill came from.
  const describeSource = (skill: string) => skillSources.get(skill) || "unknown origin";
  const packagedSkills = new Set(
    catalogue.skill_entries
      .filter((entry) => entry.source === "packaged")
      .map((entry) => entry.name),
  );
  const shadowedSkills = skills
    .filter((skill) => skill.kind === "skill" && packagedSkills.has(skill.name))
    .map((skill) => skill.name);
  const skillGroups = buildAdminSkillGroups(
    catalogue.skill_entries,
    skills,
    disabledPackagedSkills,
  );
  const resolvedByName = new Map(
    resolvedCommands.map((command) => [command.name, command]),
  );
  const commandOverrideNames = new Set(
    commandOverrides.map((command) => command.name),
  );
  const draftedNames = new Set(commandDrafts.map((command) => command.name));
  const commandRows = [
    ...commandDrafts.map((draft, index) => ({
      draft,
      index: index as number | null,
      resolved: resolvedByName.get(draft.name),
    })),
    ...resolvedCommands
      .filter((command) => !draftedNames.has(command.name))
      .map((command) => ({
        // A row for a command that has no override yet: the same shape, so the
        // editor does not have to care whether it is editing an existing entry
        // or writing the first one.
        draft: { name: command.name } as CommandDraft,
        index: null,
        resolved: command,
      })),
  ];

  if (admin.status !== "authenticated") {
    return (
      <AdminLoginMask
        checking={admin.status === "checking"}
        onAuthenticated={(name) =>
          setAdmin({ status: "authenticated", name })
        }
      />
    );
  }

  return (
    <main className={styles.shell}>
      <div className={styles.inner}>
        <header className={styles.header}>
          <div>
            <p className={styles.eyebrow}>GTMBuddy</p>
            <h1>Runtime administration</h1>
          </div>
          <div className={styles.headerActions}>
            <span>{admin.name}</span>
            <button type="button" onClick={() => void signOut()}>
              Sign out
            </button>
            <Link href="/">Back to chat</Link>
          </div>
        </header>

        <div className={styles.tabs} role="tablist">
          {(["models", "mcp", "skills", "commands", "profiles"] as const).map((name) => (
            <button
              key={name}
              role="tab"
              type="button"
              aria-selected={tab === name}
              onClick={() => setTab(name)}
            >
              {name === "models"
                ? "Model access"
                : name === "mcp"
                  ? "Remote MCP"
                  : name === "skills"
                    ? "Skills"
                    : name === "commands"
                      ? "Commands"
                      : "Agent profiles"}
            </button>
          ))}
        </div>

        {error && <div className={styles.error}>{error}</div>}

        {tab === "models" && (
          <section className={styles.panel}>
            <h2>LLM access</h2>
            <p className={styles.hint}>
              Blank fields keep the value the container was deployed with. The key is
              write-only: it is stored but never read back into this page.
            </p>
            <div className={styles.grid}>
              <label>
                Model
                <input
                  value={models.model}
                  onChange={(event) =>
                    setModels({ ...models, model: event.target.value })
                  }
                  placeholder="gpt-5.2-codex"
                />
              </label>
              <label>
                Endpoint
                <input
                  type="url"
                  value={models.endpoint}
                  onChange={(event) =>
                    setModels({ ...models, endpoint: event.target.value })
                  }
                  placeholder="https://….openai.azure.com/openai/v1"
                />
              </label>
              <label>
                Provider
                <input
                  value={models.provider}
                  onChange={(event) =>
                    setModels({ ...models, provider: event.target.value })
                  }
                  placeholder="digibuddy"
                />
              </label>
              <label>
                Reasoning effort
                <select
                  value={models.reasoning_effort}
                  onChange={(event) =>
                    setModels({ ...models, reasoning_effort: event.target.value })
                  }
                >
                  <option value="">Deployed default</option>
                  {EFFORTS.map((effort) => (
                    <option key={effort} value={effort}>
                      {effort}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                API key {models.api_key_set ? "(stored — blank keeps it)" : ""}
                <input
                  type="password"
                  autoComplete="off"
                  value={models.api_key ?? ""}
                  onChange={(event) =>
                    setModels({ ...models, api_key: event.target.value })
                  }
                  placeholder={models.api_key_set ? "••••••••" : "Deployed default"}
                />
              </label>
            </div>
            <div className={styles.actions}>
              <button
                disabled={busy}
                type="button"
                onClick={() => save("models.json", models)}
              >
                Save model access
              </button>
              {status && <span className={styles.status}>{status}</span>}
            </div>
          </section>
        )}

        {tab === "mcp" && (
          <section className={styles.panel}>
            <h2>MCP servers</h2>
            <p className={styles.hint}>
              Remote servers are streamable HTTP over HTTPS. A local server runs
              as a command inside the container, so it starts with Codex whether
              or not the agent asks for it — register one only if you would run
              the same command yourself. Bearer tokens come from a profile
              credential or a container environment variable, never from here.
            </p>
            {servers.map((server, index) => (
              <div className={styles.row} key={index}>
                <div className={styles.rowHeader}>
                  <strong>{server.name || "New server"}</strong>
                  <button
                    className={styles.remove}
                    type="button"
                    onClick={() =>
                      setServers(servers.filter((_, position) => position !== index))
                    }
                  >
                    Remove
                  </button>
                </div>
                <div className={styles.grid}>
                  <label>
                    Name
                    <input
                      value={server.name}
                      onChange={(event) =>
                        setServers(
                          servers.map((entry, position) =>
                            position === index
                              ? { ...entry, name: event.target.value }
                              : entry,
                          ),
                        )
                      }
                      placeholder="microsoft-learn"
                    />
                  </label>
                  <label>
                    URL
                    <input
                      type="url"
                      value={server.url}
                      onChange={(event) =>
                        setServers(
                          servers.map((entry, position) =>
                            position === index
                              ? { ...entry, url: event.target.value }
                              : entry,
                          ),
                        )
                      }
                      placeholder="https://learn.microsoft.com/api/mcp"
                      disabled={Boolean(server.command)}
                    />
                  </label>
                  <label>
                    Local command
                    <input
                      value={server.command ?? ""}
                      onChange={(event) =>
                        setServers(
                          servers.map((entry, position) =>
                            position === index
                              ? { ...entry, command: event.target.value }
                              : entry,
                          ),
                        )
                      }
                      placeholder="python — runs inside the container"
                      disabled={Boolean(server.url)}
                    />
                  </label>
                  <label>
                    Command arguments
                    <input
                      value={(server.args ?? []).join(" ")}
                      onChange={(event) =>
                        setServers(
                          servers.map((entry, position) =>
                            position === index
                              ? {
                                  ...entry,
                                  args: event.target.value
                                    .split(/\s+/)
                                    .filter(Boolean),
                                }
                              : entry,
                          ),
                        )
                      }
                      placeholder="-m your_package.mcp"
                      disabled={!server.command}
                    />
                  </label>
                  <label>
                    Bearer token environment variable
                    <input
                      value={server.bearer_token_env_var}
                      onChange={(event) =>
                        setServers(
                          servers.map((entry, position) =>
                            position === index
                              ? { ...entry, bearer_token_env_var: event.target.value }
                              : entry,
                          ),
                        )
                      }
                      placeholder="Anonymous if blank"
                    />
                  </label>
                </div>
                <div className={styles.checks}>
                  <label>
                    <input
                      type="checkbox"
                      checked={server.enabled}
                      onChange={(event) =>
                        setServers(
                          servers.map((entry, position) =>
                            position === index
                              ? { ...entry, enabled: event.target.checked }
                              : entry,
                          ),
                        )
                      }
                    />
                    Enabled
                  </label>
                </div>
              </div>
            ))}
            <div className={styles.actions}>
              <button
                className={styles.secondary}
                type="button"
                onClick={() =>
                  setServers([
                    ...servers,
                    {
                      name: "",
                      url: "",
                      enabled: true,
                      bearer_token_env_var: "",
                      description: "",
                    },
                  ])
                }
              >
                Add server
              </button>
              <button
                disabled={busy}
                type="button"
                onClick={() =>
                  save("mcp.json", {
                    servers: Object.fromEntries(
                      servers.map(({ name, ...server }) => [name, server]),
                    ),
                  })
                }
              >
                Save MCP servers
              </button>
              {status && <span className={styles.status}>{status}</span>}
            </div>
          </section>
        )}

        {tab === "skills" && (
          <section className={styles.panel}>
            <h2>Skills</h2>
            <p className={styles.hint}>
              This is the full skill inventory. Switching a skill off stops it
              being installed into the runtime at the next turn, so no agent
              profile can use it and it disappears from the / menu. Runtime
              configuration is re-read at turn boundaries, so changes apply from
              the next turn.
            </p>
            {shadowedSkills.length > 0 && (
              <div className={styles.error}>
                These uploaded skills share names with packaged skills and are not live:
                {" "}
                {shadowedSkills.join(", ")}. The runtime keeps the packaged copy.
              </div>
            )}

            <div className={styles.row}>
              <div className={styles.rowHeader}>
                <strong>Skills loaded by default</strong>
                <span className={styles.version}>
                  {skillGroups.counts.packaged} total · {skillGroups.counts.packagedOff} off
                </span>
              </div>
              <p className={styles.hint}>
                These are baked into the image. They have no version, approval or
                withdrawal action here; the switch only controls whether the
                runtime installs them.
              </p>
              <p className={styles.hint}>
                A <strong>built-in</strong> skill loads itself when a request
                matches it, and a <strong>hidden</strong> one is reached only
                through a command that bundles it. Neither appears in the chat
                menu, which is deliberate rather than a fault — both are still
                installed and still work.
              </p>
              {skillGroups.packaged.length === 0 ? (
                <p className={styles.hint}>
                  No packaged skills are published yet. A runtime older than this
                  console does not say where a skill came from, so nothing can be
                  listed here until it is upgraded — the skills themselves are
                  unaffected and still load.
                </p>
              ) : (
                skillGroups.packaged.map((skill) => (
                  <div className={styles.row} key={skill.name}>
                    <div className={styles.rowHeader}>
                      <strong>
                        {skill.name}
                        {skill.availability === "builtin" && (
                          <span className={styles.version}> · built-in</span>
                        )}
                        {skill.availability === "hidden" && (
                          <span className={styles.version}> · hidden</span>
                        )}
                        {!skill.enabled && (
                          <span className={styles.version}> · off</span>
                        )}
                      </strong>
                    </div>
                    {skill.description && (
                      <p className={`${styles.hint} ${styles.clamp}`}>
                        {skill.description}
                      </p>
                    )}
                    <div className={styles.checks}>
                      <label>
                        <input
                          type="checkbox"
                          checked={skill.enabled}
                          disabled={busy}
                          onChange={(event) =>
                            void togglePackagedSkill(skill.name, event.target.checked)
                          }
                        />
                        Enabled
                      </label>
                    </div>
                  </div>
                ))
              )}
            </div>

            <div className={styles.row}>
              <div className={styles.rowHeader}>
                <strong>Custom skills</strong>
                <span className={styles.version}>
                  {skillGroups.counts.custom} total · {skillGroups.counts.customOff} off
                </span>
              </div>
              <p className={styles.hint}>
                Deploy a skill archive — a zip holding <code>SKILL.md</code> and
                its references, scripts and tools — and every profile that
                assembles it loads it on the next turn, without rebuilding the
                image. A repository archive carrying several skills is unpacked
                into one self-contained skill each; add a{" "}
                <code>digibuddy-skills.json</code> manifest to say which
                directories are skills and which libraries they share. Deploying
                a skill again replaces it. Skills baked into the image cannot be
                shadowed.
              </p>
            <label className={styles.upload}>
              Skill archive (.zip)
              <input
                type="file"
                accept=".zip,.skill,application/zip"
                disabled={busy}
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  event.target.value = "";
                  if (file) void preview({ file });
                }}
              />
            </label>
            {allowedHosts.length > 0 && (
              <>
                <label>
                  Or import from a URL
                  <input
                    type="url"
                    value={source}
                    placeholder="https://codeload.github.com/owner/repo/zip/refs/heads/main"
                    disabled={busy}
                    onChange={(event) => setSource(event.target.value)}
                  />
                </label>
                <p className={styles.hint}>Allowed hosts: {allowedHosts.join(", ")}</p>
                <div className={styles.actions}>
                  <button
                    type="button"
                    disabled={busy || !source.trim()}
                    onClick={() => void preview({ source: source.trim() })}
                  >
                    Preview
                  </button>
                </div>
              </>
            )}

            {pending && (
              <div className={styles.row}>
                <div className={styles.rowHeader}>
                  <strong>
                    {pending.preview.skills.length} capability(s) ready to deploy
                  </strong>
                  <button
                    className={styles.remove}
                    type="button"
                    disabled={busy}
                    onClick={() => setPending(null)}
                  >
                    Cancel
                  </button>
                </div>
                <p className={styles.hint}>{LAYOUTS[pending.preview.layout]}</p>
                {pending.preview.notes.map((note) => (
                  <p className={styles.hint} key={note}>
                    {note}
                  </p>
                ))}
                {pending.preview.skills.some((skill) => skill.kind !== "skill") && (
                  <p className={styles.hint}>
                    This archive contains code. Tools and MCP servers deploy
                    switched off; each one has to be approved separately, and the
                    approval names the exact bytes below.
                  </p>
                )}
                {pending.preview.skills.map((skill) => (
                  <div key={skill.name}>
                    <strong>{skill.name}</strong>
                    <span className={styles.version}> {KINDS[skill.kind]}</span>
                    {skills.some((existing) => existing.name === skill.name) && (
                      <span className={styles.version}> · replaces the deployed version</span>
                    )}
                    {skill.description && (
                      <p className={styles.clamp}>{skill.description}</p>
                    )}
                    {skill.declaration && (
                      <p className={styles.hint}>
                        runs {JSON.stringify(skill.declaration)}
                      </p>
                    )}
                    <p className={styles.hint}>
                      {Math.max(1, Math.round(skill.size / 1024))} KB ·{" "}
                      {skill.entries.length} files · {skill.sha256.slice(0, 12)}
                    </p>
                  </div>
                ))}
                <div className={styles.actions}>
                  <button type="button" disabled={busy} onClick={() => void deploy()}>
                    Deploy
                  </button>
                </div>
              </div>
            )}
            {skillGroups.custom.length === 0 && (
              <p className={styles.hint}>No skills have been deployed yet.</p>
            )}
            {skillGroups.custom.map((skill) => (
              <div className={styles.row} key={skill.name}>
                <div className={styles.rowHeader}>
                  <strong>
                    {skill.name}{" "}
                    <span className={styles.version}>
                      v{skill.version}
                      {!skill.enabled && " · off"}
                    </span>
                  </strong>
                  <button
                    className={styles.remove}
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      void callSkills(
                        { method: "DELETE" },
                        "Unable to withdraw the skill.",
                        `?name=${encodeURIComponent(skill.name)}`,
                      )
                    }
                  >
                    Withdraw
                  </button>
                </div>
                {skill.description && <p>{skill.description}</p>}
                {packagedSkills.has(skill.name) && (
                  <p className={styles.hint}>
                    A packaged skill with this name is live; this deployed upload is
                    shadowed and will not replace it.
                  </p>
                )}
                <p className={styles.hint}>
                  {Math.max(1, Math.round(skill.size / 1024))} KB · {skill.sha256.slice(0, 12)} ·
                  uploaded {skill.uploaded_at.slice(0, 10)} by {skill.uploaded_by}
                  {skill.source && ` · from ${skill.source}`}
                </p>
                {skill.kind !== "skill" && (
                  <p className={styles.hint}>
                    {KINDS[skill.kind]}
                    {Object.keys(skill.declaration).length > 0 &&
                      ` · runs ${JSON.stringify(skill.declaration)}`}
                  </p>
                )}
                <div className={styles.checks}>
                  <label>
                    <input
                      type="checkbox"
                      checked={skill.enabled}
                      disabled={busy}
                      onChange={(event) =>
                        void callSkills(
                          {
                            method: "PATCH",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({
                              name: skill.name,
                              enabled: event.target.checked,
                            }),
                          },
                          "Unable to update the skill.",
                        )
                      }
                    />
                    Enabled
                  </label>
                  {skill.kind !== "skill" && (
                    <label>
                      <input
                        type="checkbox"
                        checked={skill.approved_sha256 === skill.sha256}
                        disabled={busy}
                        onChange={(event) =>
                          void callSkills(
                            {
                              method: "PATCH",
                              headers: { "Content-Type": "application/json" },
                              body: JSON.stringify({
                                name: skill.name,
                                approve: event.target.checked,
                                // Names the bytes being approved, so approving a
                                // stale listing is refused rather than applied.
                                sha256: skill.sha256,
                              }),
                            },
                            "Unable to change the approval.",
                          )
                        }
                      />
                      Approved to run {skill.sha256.slice(0, 12)}
                      {skill.approved_by && ` · by ${skill.approved_by}`}
                    </label>
                  )}
                </div>
                {skill.kind !== "skill" &&
                  skill.enabled &&
                  skill.approved_sha256 !== skill.sha256 && (
                    <p className={styles.hint}>
                      Enabled but not approved, so the runtime will not start it.
                    </p>
                  )}
              </div>
            ))}
            </div>
            {status && <span className={styles.status}>{status}</span>}
          </section>
        )}

        {tab === "commands" && (
          <section className={styles.panel}>
            <h2>Slash commands</h2>
            <p className={styles.hint}>
              Users see the resolved list: every reachable skill is auto-discovered,
              then these overrides rename, describe, hide, order or bundle commands.
              Deleting an override reverts the command; it does not remove any skill.
            </p>
            {shadowedSkills.length > 0 && (
              <div className={styles.error}>
                Shadowed uploads are not live commands because packaged skills win:
                {" "}
                {shadowedSkills.join(", ")}.
              </div>
            )}
            <div className={styles.row}>
              <div className={styles.rowHeader}>
                <strong>Resolved for users</strong>
              </div>
              {resolvedCommands.length === 0 ? (
                <p className={styles.hint}>No commands are currently available.</p>
              ) : (
                <div className={styles.checks}>
                  {resolvedCommands.map((command) => (
                    <span key={command.name}>
                      /{command.name} · {command.title} ·{" "}
                      {command.skills
                        .map((skill) => `${skill} (${describeSource(skill)})`)
                        .join(", ")}
                    </span>
                  ))}
                </div>
              )}
            </div>

            {commandRows.map(({ draft, index, resolved }) => {
              const effective = {
                name: draft.name,
                title: draft.title ?? resolved?.title ?? "",
                description: draft.description ?? resolved?.description ?? "",
                hint: draft.hint ?? resolved?.hint ?? "",
                enabled: draft.enabled ?? resolved?.enabled ?? true,
                order: draft.order ?? resolved?.order ?? 0,
                skills: draft.skills ?? resolved?.skills ?? [],
              };
              const rowKey = commandDraftKey(draft, resolved);
              const hasStoredOverride = commandOverrideNames.has(draft.name);
              const canDiscardDraft = index !== null && !hasStoredOverride;
              return (
                <div className={styles.row} key={rowKey}>
                  <div className={styles.rowHeader}>
                    <strong>{effective.name ? `/${effective.name}` : "New command"}</strong>
                    {(draft.local || hasStoredOverride || canDiscardDraft) && (
                      <button
                        className={styles.remove}
                        type="button"
                        disabled={busy}
                        onClick={() =>
                          draft.local || canDiscardDraft
                            ? index !== null && discardCommandDraft(index, draft.name)
                            : void deleteCommand(draft.name)
                        }
                      >
                        {draft.local
                          ? "Remove"
                          : canDiscardDraft
                            ? "Discard"
                            : "Delete override"}
                      </button>
                    )}
                  </div>
                  {resolved && (
                    <p className={styles.hint}>
                      Resolved now as “{resolved.title}” loading{" "}
                      {resolved.skills.join(", ")}.
                    </p>
                  )}
                  <div className={styles.grid}>
                    <label>
                      Command name
                      <input
                        value={effective.name}
                        disabled={!draft.local && Boolean(effective.name)}
                        onChange={(event) =>
                          updateCommandDraft(index, draft.name, {
                            name: event.target.value,
                          })
                        }
                        placeholder="customer-brief"
                      />
                    </label>
                    <label>
                      Title
                      <input
                        value={effective.title}
                        onChange={(event) =>
                          updateCommandDraft(index, draft.name, {
                            title: event.target.value,
                          })
                        }
                        placeholder={resolved?.title || "Customer Brief"}
                      />
                    </label>
                    <label>
                      Order
                      <input
                        type="number"
                        value={draft.orderInput ?? String(effective.order)}
                        onChange={(event) =>
                          updateCommandDraft(index, draft.name, {
                            ...parseCommandOrder(
                              event.target.value,
                              effective.order,
                            ),
                          })
                        }
                      />
                    </label>
                    <label>
                      Hint
                      <input
                        value={effective.hint}
                        onChange={(event) =>
                          updateCommandDraft(index, draft.name, {
                            hint: event.target.value,
                          })
                        }
                        placeholder="Shown after the command is chosen"
                      />
                    </label>
                  </div>
                  <label>
                    Description
                    <textarea
                      value={effective.description}
                      onChange={(event) =>
                        updateCommandDraft(index, draft.name, {
                          description: event.target.value,
                        })
                      }
                      placeholder="What this command should do"
                    />
                  </label>
                  <div>
                    <div className={styles.rowHeader}>
                      <strong>Skills loaded by this command</strong>
                    </div>
                    <div className={styles.checks}>
                      {assignableSkills.map((skill) => {
                        const selected = effective.skills.includes(skill);
                        return (
                          <label key={skill}>
                            <input
                              type="checkbox"
                              checked={selected}
                              onChange={() =>
                                updateCommandDraft(index, draft.name, {
                                  skills: selected
                                    ? effective.skills.filter((entry) => entry !== skill)
                                    : [...effective.skills, skill],
                                })
                              }
                            />
                            {skill} · {describeSource(skill)}
                            {packagedSkills.has(skill) &&
                              skills.some((entry) => entry.name === skill) &&
                              " · deployed upload shadowed"}
                          </label>
                        );
                      })}
                    </div>
                  </div>
                  <div className={styles.checks}>
                    <label>
                      <input
                        type="checkbox"
                        checked={effective.enabled}
                        onChange={(event) =>
                          updateCommandDraft(index, draft.name, {
                            enabled: event.target.checked,
                          })
                        }
                      />
                      Enabled in the slash menu
                    </label>
                  </div>
                  <div className={styles.actions}>
                    <button
                      type="button"
                      disabled={busy || !effective.name.trim()}
                      onClick={() => void saveCommand(draft)}
                    >
                      Save override
                    </button>
                  </div>
                </div>
              );
            })}
            <div className={styles.actions}>
              <button
                className={styles.secondary}
                type="button"
                onClick={() =>
                  setCommandDrafts([
                    ...commandDrafts,
                    createLocalCommandDraft(),
                  ])
                }
              >
                Add curated command
              </button>
              {status && <span className={styles.status}>{status}</span>}
            </div>
          </section>
        )}

        {tab === "profiles" && (
          <section className={styles.panel}>
            <h2>Agent profiles</h2>
            <p className={styles.hint}>
              A profile assembles a subset of the capabilities this image ships. It
              keeps the prompt focused; it is not a security boundary, so grant each
              profile only the credentials it needs. Leave a group on “allow all” to
              inherit every packaged capability.
            </p>
            {profiles.map((profile, index) => (
              <div className={styles.row} key={index}>
                <div className={styles.rowHeader}>
                  <strong>{profile.display_name || profile.name || "New profile"}</strong>
                  <button
                    className={styles.remove}
                    type="button"
                    onClick={() =>
                      setProfiles(profiles.filter((_, position) => position !== index))
                    }
                  >
                    Remove
                  </button>
                </div>
                <div className={styles.grid}>
                  <label>
                    Name
                    <input
                      value={profile.name}
                      onChange={(event) =>
                        updateProfile(index, { name: event.target.value })
                      }
                      placeholder="marketing"
                    />
                  </label>
                  <label>
                    Display name
                    <input
                      value={profile.display_name}
                      onChange={(event) =>
                        updateProfile(index, { display_name: event.target.value })
                      }
                    />
                  </label>
                  <label>
                    Model override
                    <input
                      value={profile.model}
                      onChange={(event) =>
                        updateProfile(index, { model: event.target.value })
                      }
                      placeholder="Runtime default"
                    />
                  </label>
                  <label>
                    Reasoning effort
                    <select
                      value={profile.reasoning_effort}
                      onChange={(event) =>
                        updateProfile(index, { reasoning_effort: event.target.value })
                      }
                    >
                      <option value="">Runtime default</option>
                      {EFFORTS.map((effort) => (
                        <option key={effort} value={effort}>
                          {effort}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
                <label>
                  Description
                  <input
                    value={profile.description}
                    onChange={(event) =>
                      updateProfile(index, { description: event.target.value })
                    }
                  />
                </label>
                <label>
                  Persona
                  <textarea
                    value={profile.persona}
                    onChange={(event) =>
                      updateProfile(index, { persona: event.target.value })
                    }
                    placeholder="Appended to the agent instructions."
                  />
                </label>
                <Selector
                  label="Skills"
                  available={assignableSkills}
                  selection={profile.skills}
                  onChange={(skills) => updateProfile(index, { skills })}
                />
                <Selector
                  label="Tools"
                  available={assignableTools}
                  selection={profile.tools}
                  onChange={(tools) => updateProfile(index, { tools })}
                />
                <Selector
                  label="MCP servers"
                  available={assignableMcpServers}
                  selection={profile.mcp_servers}
                  onChange={(mcp_servers) => updateProfile(index, { mcp_servers })}
                />
                <Credentials
                  profile={profile.name}
                  statuses={credentials}
                  busy={busy}
                  onChange={(slot, action, value) =>
                    void changeCredential(profile.name, slot, action, value)
                  }
                />
              </div>
            ))}
            <div className={styles.actions}>
              <button
                className={styles.secondary}
                type="button"
                onClick={() => setProfiles([...profiles, { ...emptyProfile }])}
              >
                Add profile
              </button>
              <button
                disabled={busy}
                type="button"
                onClick={() => save("profiles.json", { profiles })}
              >
                Save profiles
              </button>
              {status && <span className={styles.status}>{status}</span>}
            </div>
          </section>
        )}
      </div>
    </main>
  );
}
