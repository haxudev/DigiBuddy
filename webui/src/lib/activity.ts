/**
 * Live agent activity: the thinking summary, the tools it runs, and anything
 * that failed. The Hosted Agent sends these as ordinary Responses output items
 * (reasoning items and function calls); this module turns that stream into the
 * compact, collapsible timeline the console renders next to the answer.
 */

export type ActivityKind = "thinking" | "tool" | "error";

export type ActivityStatus = "running" | "done" | "failed";

export type ActivityEntry = {
  id: string;
  kind: ActivityKind;
  /** One line, always shown. */
  title: string;
  /** Everything received so far, revealed when the row is expanded. */
  detail: string;
  status: ActivityStatus;
  /** Raw tool name, kept so the title can be re-derived as arguments stream. */
  name?: string;
};

export type ActivityEvent =
  | { kind: "thinking"; id: string; delta: string }
  | { kind: "thinking-end"; id: string }
  | { kind: "tool"; id: string; name: string }
  | { kind: "tool-detail"; id: string; delta: string }
  | { kind: "tool-end"; id: string }
  | { kind: "error"; id: string; message: string };

export const ACTIVITY_EVENT_NAME = "activity";

const TOOL_LABELS: Record<string, string> = {
  commandExecution: "Ran a command",
  fileChange: "Edited files",
  mcpToolCall: "Called an MCP tool",
  dynamicToolCall: "Called a tool",
  webSearch: "Searched the web",
};

const MAX_TITLE_LENGTH = 120;

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

/** Collapse any text to the single line the timeline shows. */
export function summarize(value: string, fallback = ""): string {
  const line = value.replace(/\s+/g, " ").trim();
  if (!line) return fallback;
  if (line.length <= MAX_TITLE_LENGTH) return line;
  return `${line.slice(0, MAX_TITLE_LENGTH - 1)}…`;
}

function toolTitle(name: string, detail: string): string {
  const label = TOOL_LABELS[name] || name || "Tool";
  if (!detail.trim()) return label;
  try {
    const parsed = record(JSON.parse(detail));
    const summary = text(parsed.summary);
    if (summary) return summarize(summary, label);
  } catch {
    // Arguments arrive in fragments, so incomplete JSON is expected.
  }
  return label;
}

/**
 * Map a raw Responses stream event onto an activity event. Anything unrelated
 * to reasoning or tool calls returns null and is left to the text handling.
 */
export function activityFromUpstream(event: unknown): ActivityEvent | null {
  const raw = record(event);
  const type = text(raw.type);

  if (type === "response.reasoning_summary_text.delta") {
    const delta = text(raw.delta);
    if (!delta) return null;
    return { kind: "thinking", id: text(raw.item_id) || "reasoning", delta };
  }
  if (type === "response.reasoning_summary_text.done") {
    return { kind: "thinking-end", id: text(raw.item_id) || "reasoning" };
  }
  if (type === "response.function_call_arguments.delta") {
    const delta = text(raw.delta);
    if (!delta) return null;
    return { kind: "tool-detail", id: text(raw.item_id), delta };
  }
  if (type === "response.output_item.added" || type === "response.output_item.done") {
    const item = record(raw.item);
    if (text(item.type) !== "function_call") return null;
    const id = text(item.id) || text(item.call_id);
    if (!id) return null;
    return type === "response.output_item.added"
      ? { kind: "tool", id, name: text(item.name) }
      : { kind: "tool-end", id };
  }
  return null;
}

function replace(
  entries: ActivityEntry[],
  id: string,
  change: (entry: ActivityEntry) => ActivityEntry,
): ActivityEntry[] {
  let found = false;
  const next = entries.map((entry) => {
    if (entry.id !== id) return entry;
    found = true;
    return change(entry);
  });
  return found ? next : entries;
}

export function reduceActivity(
  entries: ActivityEntry[],
  event: ActivityEvent,
): ActivityEntry[] {
  switch (event.kind) {
    case "thinking": {
      const existing = entries.find((entry) => entry.id === event.id);
      if (!existing) {
        return [
          ...entries,
          {
            id: event.id,
            kind: "thinking",
            title: summarize(event.delta, "Thinking…"),
            detail: event.delta,
            status: "running",
          },
        ];
      }
      const detail = existing.detail + event.delta;
      return replace(entries, event.id, (entry) => ({
        ...entry,
        detail,
        title: summarize(detail, "Thinking…"),
      }));
    }
    case "thinking-end":
      return replace(entries, event.id, (entry) => ({
        ...entry,
        status: "done",
      }));
    case "tool": {
      if (entries.some((entry) => entry.id === event.id)) return entries;
      return [
        ...entries,
        {
          id: event.id,
          kind: "tool",
          title: toolTitle(event.name, ""),
          detail: "",
          status: "running",
          name: event.name,
        },
      ];
    }
    case "tool-detail": {
      const existing = entries.find((entry) => entry.id === event.id);
      if (!existing) return entries;
      const detail = existing.detail + event.delta;
      return replace(entries, event.id, (entry) => ({
        ...entry,
        detail,
        title: toolTitle(entry.name ?? "", detail),
      }));
    }
    case "tool-end":
      return replace(entries, event.id, (entry) => ({
        ...entry,
        status: "done",
      }));
    case "error":
      return [
        ...entries.map((entry) =>
          entry.status === "running" ? { ...entry, status: "failed" as const } : entry,
        ),
        {
          id: event.id,
          kind: "error",
          title: summarize(event.message, "The agent reported an error"),
          detail: event.message,
          status: "failed",
        },
      ];
    default:
      return entries;
  }
}

/** Mark anything still running as finished once the run ends. */
export function settleActivity(entries: ActivityEntry[]): ActivityEntry[] {
  if (!entries.some((entry) => entry.status === "running")) return entries;
  return entries.map((entry) =>
    entry.status === "running" ? { ...entry, status: "done" } : entry,
  );
}

export function isActivityEvent(value: unknown): value is ActivityEvent {
  const raw = record(value);
  return typeof raw.kind === "string" && typeof raw.id === "string";
}
