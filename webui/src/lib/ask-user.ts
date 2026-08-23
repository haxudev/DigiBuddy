export type AskUserOption = {
  value: string;
  label: string;
  description: string;
};

export type AskUserRequest = {
  id: string;
  question: string;
  type: "single" | "multi" | "text";
  options: AskUserOption[];
  allowOther: boolean;
  placeholder: string;
};

export type MessageSegment =
  | { kind: "markdown"; text: string }
  | { kind: "ask"; request: AskUserRequest };

/**
 * The agent asks a structured question by emitting a fenced block tagged
 * `ask-user` (or `ask_user`) whose body is a JSON object. Anything the parser
 * cannot understand is left untouched and rendered as ordinary markdown.
 */
const ASK_BLOCK = /```[ \t]*ask[-_]user[ \t]*\r?\n([\s\S]*?)```/g;

function toOption(value: unknown): AskUserOption | null {
  if (typeof value === "string") {
    const label = value.trim();
    if (!label) return null;
    return { value: label, label, description: "" };
  }
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const label =
    typeof raw.label === "string" && raw.label.trim()
      ? raw.label.trim()
      : typeof raw.value === "string"
        ? raw.value.trim()
        : "";
  if (!label) return null;
  const optionValue =
    typeof raw.value === "string" && raw.value.trim() ? raw.value.trim() : label;
  return {
    value: optionValue,
    label,
    description:
      typeof raw.description === "string" ? raw.description.trim() : "",
  };
}

export function parseAskUser(body: string, id: string): AskUserRequest | null {
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    return null;
  }
  if (!payload || typeof payload !== "object") return null;
  const raw = payload as Record<string, unknown>;
  const question =
    typeof raw.question === "string"
      ? raw.question.trim()
      : typeof raw.prompt === "string"
        ? raw.prompt.trim()
        : "";
  if (!question) return null;

  const options = Array.isArray(raw.options)
    ? raw.options
        .map((option) => toOption(option))
        .filter((option): option is AskUserOption => option !== null)
    : [];

  const requestedType = typeof raw.type === "string" ? raw.type.trim() : "";
  let type: AskUserRequest["type"];
  if (requestedType === "multi" || requestedType === "multiple") {
    type = "multi";
  } else if (requestedType === "text" || options.length === 0) {
    type = "text";
  } else {
    type = "single";
  }
  // A choice question without options is unanswerable, so fall back to text.
  if (type !== "text" && options.length === 0) type = "text";

  return {
    id: typeof raw.id === "string" && raw.id.trim() ? raw.id.trim() : id,
    question,
    type,
    options,
    allowOther: raw.allowOther === true || raw.allow_other === true,
    placeholder:
      typeof raw.placeholder === "string" ? raw.placeholder.trim() : "",
  };
}

export function splitMessage(text: string, messageId: string): MessageSegment[] {
  const segments: MessageSegment[] = [];
  let cursor = 0;
  let index = 0;

  ASK_BLOCK.lastIndex = 0;
  for (let match = ASK_BLOCK.exec(text); match; match = ASK_BLOCK.exec(text)) {
    const request = parseAskUser(match[1], `${messageId}-ask-${index}`);
    if (!request) continue;
    const before = text.slice(cursor, match.index);
    if (before.trim()) segments.push({ kind: "markdown", text: before });
    segments.push({ kind: "ask", request });
    cursor = match.index + match[0].length;
    index += 1;
  }

  const rest = text.slice(cursor);
  if (rest.trim() || segments.length === 0) {
    segments.push({ kind: "markdown", text: rest });
  }
  return segments;
}

export function formatAskUserAnswer(
  request: AskUserRequest,
  values: string[],
): string {
  const answers = values.map((value) => value.trim()).filter(Boolean);
  if (answers.length === 0) return "";
  if (request.type === "text") return answers.join("\n");
  return `${request.question}\n${answers.map((value) => `- ${value}`).join("\n")}`;
}
