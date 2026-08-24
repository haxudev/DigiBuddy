"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  CREDENTIAL_SLOTS,
  type CredentialStatus,
} from "@/lib/credentials";
import styles from "./admin.module.css";

type Catalogue = { skills: string[]; tools: string[]; mcp_servers: string[] };

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

const EFFORTS = ["minimal", "low", "medium", "high"];

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

async function fetchConfig(): Promise<ConfigPayload> {
  const response = await fetch("/api/admin/config", { cache: "no-store" });
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.error || "Unable to load configuration.");
  }
  return payload as ConfigPayload;
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
  const [tab, setTab] = useState<"models" | "mcp" | "skills" | "profiles">("models");
  const [catalogue, setCatalogue] = useState<Catalogue>({
    skills: [],
    tools: [],
    mcp_servers: [],
  });
  const [models, setModels] = useState<Models>(emptyModels);
  const [servers, setServers] = useState<NamedServer[]>([]);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [skills, setSkills] = useState<DeployedSkill[]>([]);
  const [allowedHosts, setAllowedHosts] = useState<string[]>([]);
  const [source, setSource] = useState("");
  const [revisions, setRevisions] = useState<Record<string, string>>({});
  const [credentials, setCredentials] = useState<CredentialStatus[]>([]);
  const [pending, setPending] = useState<Pending | null>(null);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    return fetchConfig().then(
      (payload) => {
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
          ...(payload["catalogue.json"] ?? {}),
        });
      },
      (loadError: unknown) => {
        setError(loadError instanceof Error ? loadError.message : "Unable to load.");
      },
    );
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Whether importing from a URL is offered at all is a deployment decision, so
  // ask the server rather than guessing.
  useEffect(() => {
    fetch("/api/admin/credentials", { cache: "no-store" })
      .then((response) => (response.ok ? response.json() : { credentials: [] }))
      .then((payload) => setCredentials(payload.credentials ?? []))
      .catch(() => setCredentials([]));
  }, []);

  useEffect(() => {
    fetch("/api/admin/skills/preview", { cache: "no-store" })
      .then((response) => (response.ok ? response.json() : { allowed_hosts: [] }))
      .then((payload) => setAllowedHosts(payload.allowed_hosts ?? []))
      .catch(() => setAllowedHosts([]));
  }, []);

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

  // A skill deployed a moment ago is assignable before the runtime has had a
  // chance to republish its catalogue.
  const assignableSkills = [
    ...new Set([
      ...catalogue.skills,
      ...skills.filter((skill) => skill.enabled).map((skill) => skill.name),
    ]),
  ].sort();

  return (
    <main className={styles.shell}>
      <div className={styles.inner}>
        <header className={styles.header}>
          <div>
            <p className={styles.eyebrow}>DigiBuddy</p>
            <h1>Runtime administration</h1>
          </div>
          <Link href="/">Back to chat</Link>
        </header>

        <div className={styles.tabs} role="tablist">
          {(["models", "mcp", "skills", "profiles"] as const).map((name) => (
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
            <h2>Deployed skills</h2>
            <p className={styles.hint}>
              Deploy a skill archive — a zip holding <code>SKILL.md</code> and its
              references, scripts and tools — and every profile that assembles it
              loads it on the next turn, without rebuilding the image. A repository
              archive carrying several skills is unpacked into one self-contained
              skill each; add a <code>digibuddy-skills.json</code> manifest to say
              which directories are skills and which libraries they share.
              Deploying a skill again replaces it. Skills baked into the image
              cannot be shadowed.
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
                    {skill.description && <p>{skill.description}</p>}
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
            {skills.length === 0 && (
              <p className={styles.hint}>No skills have been deployed yet.</p>
            )}
            {skills.map((skill) => (
              <div className={styles.row} key={skill.name}>
                <div className={styles.rowHeader}>
                  <strong>
                    {skill.name} <span className={styles.version}>v{skill.version}</span>
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
            {status && <span className={styles.status}>{status}</span>}
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
                  available={catalogue.tools}
                  selection={profile.tools}
                  onChange={(tools) => updateProfile(index, { tools })}
                />
                <Selector
                  label="MCP servers"
                  available={catalogue.mcp_servers}
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
