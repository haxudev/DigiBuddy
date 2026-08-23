"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
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

export default function Admin() {
  const [tab, setTab] = useState<"models" | "mcp" | "profiles">("models");
  const [catalogue, setCatalogue] = useState<Catalogue>({
    skills: [],
    tools: [],
    mcp_servers: [],
  });
  const [models, setModels] = useState<Models>(emptyModels);
  const [servers, setServers] = useState<NamedServer[]>([]);
  const [profiles, setProfiles] = useState<Profile[]>([]);
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

  async function save(document: string, value: unknown) {
    setBusy(true);
    setError("");
    setStatus("");
    try {
      const response = await fetch("/api/admin/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ document, value }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Unable to save.");
      setStatus(`Saved ${document}. It applies from the next turn.`);
      await load();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Unable to save.");
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
          {(["models", "mcp", "profiles"] as const).map((name) => (
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
            <h2>Remote MCP servers</h2>
            <p className={styles.hint}>
              Streamable HTTP servers reachable over HTTPS. Bearer tokens are read from
              a container environment variable rather than stored here.
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
                  available={catalogue.skills}
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
