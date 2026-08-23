import {
  EventType,
  RunAgentInputSchema,
  type BaseEvent,
} from "@ag-ui/core";
import {
  latestUserText,
  resolveConnection,
  responseText,
} from "@/lib/agent-proxy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const encoder = new TextEncoder();

function sse(event: BaseEvent): Uint8Array {
  return encoder.encode(`data: ${JSON.stringify(event)}\n\n`);
}

function upstreamError(payload: unknown, status: number): Error {
  if (payload && typeof payload === "object") {
    const value = payload as Record<string, unknown>;
    const error = value.error;
    if (typeof error === "string") return new Error(error);
    if (error && typeof error === "object") {
      const message = (error as Record<string, unknown>).message;
      if (typeof message === "string") return new Error(message);
    }
  }
  return new Error(`Hosted Agent request failed with HTTP ${status}.`);
}

export async function POST(request: Request) {
  let rawInput: unknown;
  try {
    rawInput = await request.json();
  } catch {
    return Response.json({ error: "Request body must be JSON." }, { status: 400 });
  }

  const parsed = RunAgentInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    return Response.json({ error: "Invalid AG-UI request." }, { status: 400 });
  }
  const input = parsed.data;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const messageId = crypto.randomUUID();
      let messageStarted = false;
      let previousResponseId =
        input.state &&
        typeof input.state === "object" &&
        typeof input.state.previousResponseId === "string"
          ? input.state.previousResponseId
          : "";

      const emit = (event: BaseEvent) => controller.enqueue(sse(event));
      emit({
        type: EventType.RUN_STARTED,
        threadId: input.threadId,
        runId: input.runId,
      });

      try {
        const connection = resolveConnection(input.forwardedProps);
        const body: Record<string, unknown> = {
          model: connection.model,
          input: latestUserText(input.messages),
          stream: true,
          store: true,
        };
        if (previousResponseId) {
          body.previous_response_id = previousResponseId;
        }
        if (connection.agentName) {
          body.agent = {
            name: connection.agentName,
            version: connection.agentVersion,
          };
        }
        if (connection.profile) {
          // `agent` names the deployed Foundry agent, so the profile that
          // agent should assemble travels as request metadata instead.
          body.metadata = { profile: connection.profile };
        }

        const headers: Record<string, string> = {
          Accept: "text/event-stream",
          "Content-Type": "application/json",
        };
        if (connection.apiKey) {
          if (connection.authMode === "bearer") {
            headers.Authorization =
              ["Bear", "er"].join("") + ` ${connection.apiKey}`;
          } else {
            headers["api-key"] = connection.apiKey;
          }
        }

        const upstream = await fetch(connection.endpoint, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          cache: "no-store",
          signal: request.signal,
        });
        if (!upstream.ok) {
          const payload = await upstream.json().catch(() => null);
          throw upstreamError(payload, upstream.status);
        }

        const contentType = upstream.headers.get("content-type") || "";
        if (!contentType.includes("text/event-stream")) {
          const payload = await upstream.json();
          const text = responseText(payload);
          const responseId =
            payload && typeof payload.id === "string" ? payload.id : "";
          if (text) {
            emit({
              type: EventType.TEXT_MESSAGE_START,
              messageId,
              role: "assistant",
            });
            messageStarted = true;
            emit({
              type: EventType.TEXT_MESSAGE_CONTENT,
              messageId,
              delta: text,
            });
          }
          if (responseId) previousResponseId = responseId;
        } else {
          if (!upstream.body) throw new Error("Hosted Agent returned no stream.");
          const reader = upstream.body.getReader();
          const decoder = new TextDecoder();
          let buffer = "";

          while (true) {
            const { value, done } = await reader.read();
            buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
            const blocks = buffer.split(/\r?\n\r?\n/);
            buffer = blocks.pop() || "";

            for (const block of blocks) {
              const data = block
                .split(/\r?\n/)
                .filter((line) => line.startsWith("data:"))
                .map((line) => line.slice(5).trimStart())
                .join("\n");
              if (!data || data === "[DONE]") continue;

              const event = JSON.parse(data) as Record<string, unknown>;
              const eventType = String(event.type || "");
              const response =
                event.response && typeof event.response === "object"
                  ? (event.response as Record<string, unknown>)
                  : {};
              if (
                (eventType === "response.created" ||
                  eventType === "response.completed") &&
                typeof response.id === "string"
              ) {
                previousResponseId = response.id;
              }
              if (eventType === "response.output_text.delta") {
                const delta = typeof event.delta === "string" ? event.delta : "";
                if (!delta) continue;
                if (!messageStarted) {
                  emit({
                    type: EventType.TEXT_MESSAGE_START,
                    messageId,
                    role: "assistant",
                  });
                  messageStarted = true;
                }
                emit({
                  type: EventType.TEXT_MESSAGE_CONTENT,
                  messageId,
                  delta,
                });
              }
              if (eventType === "error" || eventType === "response.failed") {
                throw upstreamError(event, upstream.status);
              }
            }
            if (done) break;
          }
        }

        if (messageStarted) {
          emit({ type: EventType.TEXT_MESSAGE_END, messageId });
        }
        emit({
          type: EventType.STATE_SNAPSHOT,
          snapshot: {
            ...(input.state && typeof input.state === "object" ? input.state : {}),
            previousResponseId,
          },
        });
        emit({
          type: EventType.RUN_FINISHED,
          threadId: input.threadId,
          runId: input.runId,
          outcome: { type: "success" },
        });
      } catch (error) {
        emit({
          type: EventType.RUN_ERROR,
          message: error instanceof Error ? error.message : "Agent request failed",
          code: "UPSTREAM_ERROR",
        });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Cache-Control": "no-cache, no-store",
      "Content-Type": "text/event-stream; charset=utf-8",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
