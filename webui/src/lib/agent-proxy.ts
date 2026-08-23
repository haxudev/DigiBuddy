import { ManagedIdentityCredential } from "@azure/identity";
import type { Message } from "@ag-ui/core";

export type ConnectionSettings = {
  endpoint: string;
  apiKey: string;
  authMode: "api-key" | "bearer";
  model: string;
  agentName: string;
  agentVersion: string;
  profile: string;
  useManagedIdentity: boolean;
};

type Environment = Record<string, string | undefined>;

type TokenCredential = {
  getToken(scope: string): Promise<{ token: string } | null>;
};

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export async function resolveAuthHeaders(
  connection: ConnectionSettings,
  credential?: TokenCredential,
): Promise<Record<string, string>> {
  if (connection.authMode === "api-key") {
    return connection.apiKey ? { "api-key": connection.apiKey } : {};
  }
  if (connection.apiKey) {
    return { Authorization: `Bearer ${connection.apiKey}` };
  }
  if (!connection.useManagedIdentity) {
    throw new Error("Bearer authentication requires an explicit access token.");
  }

  const clientId = stringValue(process.env.AZURE_CLIENT_ID);
  const managedIdentity =
    credential ||
    (clientId
      ? new ManagedIdentityCredential(clientId)
      : new ManagedIdentityCredential());
  const accessToken = await managedIdentity.getToken(
    "https://ai.azure.com/.default",
  );
  if (!accessToken?.token) {
    throw new Error("Managed identity did not return a Foundry access token.");
  }
  return { Authorization: `Bearer ${accessToken.token}` };
}

export function resolveConnection(
  forwardedProps: unknown,
  environment: Environment = process.env,
): ConnectionSettings {
  const props =
    forwardedProps && typeof forwardedProps === "object"
      ? (forwardedProps as Record<string, unknown>)
      : {};
  const raw =
    props.connection && typeof props.connection === "object"
      ? (props.connection as Record<string, unknown>)
      : {};
  const requestedAuthMode = stringValue(raw.authMode);
  const environmentAuthMode = environment.FOUNDRY_AUTH_MODE;
  const requestedCredential = stringValue(raw.apiKey);
  const environmentCredential = stringValue(environment.FOUNDRY_AGENT_API_KEY);
  const requestedTarget = ["endpoint", "model", "agentName", "agentVersion"].some(
    (key) => Boolean(stringValue(raw[key])),
  );
  const authMode = requestedCredential
    ? requestedAuthMode === "bearer"
      ? "bearer"
      : "api-key"
    : environmentCredential
      ? environmentAuthMode === "bearer"
        ? "bearer"
        : "api-key"
      : environmentAuthMode === "bearer" || requestedAuthMode === "bearer"
        ? "bearer"
        : "api-key";

  const connection = {
    endpoint:
      stringValue(raw.endpoint) || stringValue(environment.FOUNDRY_AGENT_ENDPOINT),
    apiKey: requestedCredential || environmentCredential,
    authMode,
    model: stringValue(raw.model) || stringValue(environment.CODEX_MODEL_NAME),
    agentName:
      stringValue(raw.agentName) || stringValue(environment.FOUNDRY_AGENT_NAME),
    agentVersion:
      stringValue(raw.agentVersion) ||
      stringValue(environment.FOUNDRY_AGENT_VERSION),
    // Selecting an agent profile. Blank means "the runtime default".
    profile: stringValue(raw.profile) || stringValue(environment.DIGIBUDDY_PROFILE),
    useManagedIdentity:
      environmentAuthMode === "bearer" &&
      !requestedTarget &&
      !stringValue(raw.apiKey) &&
      !stringValue(environment.FOUNDRY_AGENT_API_KEY),
  } satisfies ConnectionSettings;

  if (!connection.endpoint) {
    throw new Error(
      "Configure a Hosted Agent Responses endpoint in the UI or FOUNDRY_AGENT_ENDPOINT.",
    );
  }
  if (!connection.model) {
    throw new Error("Configure a Codex model name in the UI or CODEX_MODEL_NAME.");
  }
  if (connection.agentName && !connection.agentVersion) {
    throw new Error(
      "Configure a Hosted Agent version in the UI or FOUNDRY_AGENT_VERSION.",
    );
  }

  assertAllowedEndpoint(connection.endpoint, environment);
  return connection;
}

export function assertAllowedEndpoint(
  value: string,
  environment: Environment = process.env,
): URL {
  let endpoint: URL;
  try {
    endpoint = new URL(value);
  } catch {
    throw new Error("Hosted Agent endpoint is not a valid URL.");
  }

  const local =
    endpoint.hostname === "localhost" || endpoint.hostname === "127.0.0.1";
  if (endpoint.protocol !== "https:" && !(local && environment.NODE_ENV !== "production")) {
    throw new Error("Hosted Agent endpoint must use HTTPS.");
  }

  const configuredHosts = stringValue(environment.AGENT_ENDPOINT_ALLOWLIST)
    .split(",")
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean);
  const allowedHosts = [
    "services.ai.azure.com",
    "openai.azure.com",
    ...configuredHosts,
  ];
  const hostname = endpoint.hostname.toLowerCase();
  const allowed =
    (local && environment.NODE_ENV !== "production") ||
    allowedHosts.some(
      (host) => hostname === host || hostname.endsWith(`.${host}`),
    );
  if (!allowed) {
    throw new Error(
      "Hosted Agent endpoint host is not allowed. Add it to AGENT_ENDPOINT_ALLOWLIST.",
    );
  }
  return endpoint;
}

export function latestUserText(messages: Message[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== "user") continue;
    if (typeof message.content === "string" && message.content.trim()) {
      return message.content.trim();
    }
    if (Array.isArray(message.content)) {
      const text = message.content
        .map((item) =>
          typeof item === "object" && item && "text" in item
            ? String(item.text)
            : "",
        )
        .join("")
        .trim();
      if (text) return text;
    }
  }
  throw new Error("A non-empty user message is required.");
}

export function responseText(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "";
  const response = payload as Record<string, unknown>;
  if (typeof response.output_text === "string") return response.output_text;
  if (!Array.isArray(response.output)) return "";
  return response.output
    .flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const content = (item as Record<string, unknown>).content;
      return Array.isArray(content) ? content : [];
    })
    .map((content) => {
      if (!content || typeof content !== "object") return "";
      const text = (content as Record<string, unknown>).text;
      return typeof text === "string" ? text : "";
    })
    .join("");
}

export function responseTextDelta(streamed: string, payload: unknown): string {
  const completed = responseText(payload);
  if (completed.startsWith(streamed)) return completed.slice(streamed.length);
  return streamed ? "" : completed;
}

export function responseErrorMessage(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "";
  const value = payload as Record<string, unknown>;
  const response =
    value.response && typeof value.response === "object"
      ? (value.response as Record<string, unknown>)
      : {};
  for (const candidate of [value.error, response.error]) {
    if (typeof candidate === "string") return candidate;
    if (candidate && typeof candidate === "object") {
      const message = (candidate as Record<string, unknown>).message;
      if (typeof message === "string") return message;
    }
  }
  return "";
}

export const REASONING_EFFORTS = ["minimal", "low", "medium", "high"] as const;

export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

/** Matches the cap the hosted agent enforces when it writes uploads to disk. */
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

export type TurnAttachment = {
  filename: string;
  mimeType: string;
  /** A `data:` URL, which is what `FileReader.readAsDataURL` produces. */
  data: string;
};

/**
 * Read the per-turn knobs the composer sends alongside the message. Anything
 * malformed is dropped rather than forwarded, so a bad attachment cannot stop
 * the text from reaching the agent.
 */
export function turnOptions(forwardedProps: unknown): {
  attachments: TurnAttachment[];
  reasoningEffort: ReasoningEffort | "";
} {
  const props =
    forwardedProps && typeof forwardedProps === "object"
      ? (forwardedProps as Record<string, unknown>)
      : {};

  const requested = stringValue(props.reasoningEffort).toLowerCase();
  const reasoningEffort = (REASONING_EFFORTS as readonly string[]).includes(
    requested,
  )
    ? (requested as ReasoningEffort)
    : "";

  const attachments: TurnAttachment[] = [];
  let budget = MAX_ATTACHMENT_BYTES;
  for (const value of Array.isArray(props.attachments) ? props.attachments : []) {
    if (!value || typeof value !== "object") continue;
    const raw = value as Record<string, unknown>;
    const data = typeof raw.data === "string" ? raw.data : "";
    if (!data.startsWith("data:")) continue;
    // base64 is 4 characters per 3 bytes, which is close enough for a budget.
    const size = Math.ceil((data.length - data.indexOf(",") - 1) * 0.75);
    if (size > budget) continue;
    budget -= size;
    attachments.push({
      filename: stringValue(raw.filename) || "attachment",
      mimeType: stringValue(raw.mimeType),
      data,
    });
  }
  return { attachments, reasoningEffort };
}

/**
 * Build the Responses `input` for a turn. Plain text stays a plain string so
 * the request looks exactly as it did before attachments existed.
 */
export function turnInput(
  text: string,
  attachments: TurnAttachment[],
): unknown {
  if (!attachments.length) return text;
  return [
    {
      type: "message",
      role: "user",
      content: [
        { type: "input_text", text },
        ...attachments.map((attachment) =>
          attachment.mimeType.startsWith("image/")
            ? { type: "input_image", image_url: attachment.data }
            : {
                type: "input_file",
                filename: attachment.filename,
                file_data: attachment.data,
              },
        ),
      ],
    },
  ];
}
