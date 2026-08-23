import {
  EventType,
  RunAgentInputSchema,
  type BaseEvent,
} from "@ag-ui/core";
import {
  latestUserText,
  resolveAuthHeaders,
  resolveConnection,
  responseText,
  responseTextDelta,
  turnInput,
  turnOptions,
} from "@/lib/agent-proxy";
import {
  ACTIVITY_EVENT_NAME,
  activityFromUpstream,
  type ActivityEvent,
} from "@/lib/activity";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const encoder = new TextEncoder();
const KEEP_ALIVE_INTERVAL_MS = 15_000;

function sse(event: BaseEvent): Uint8Array {
  return encoder.encode(`data: ${JSON.stringify(event)}\n\n`);
}

function keepAlive(): Uint8Array {
  return encoder.encode(": keep-alive\n\n");
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
      let streamOpen = true;
      const enqueue = (value: Uint8Array) => {
        if (!streamOpen) return;
        try {
          controller.enqueue(value);
        } catch {
          streamOpen = false;
        }
      };
      const keepAliveTimer = setInterval(() => {
        enqueue(keepAlive());
      }, KEEP_ALIVE_INTERVAL_MS);
      const messageId = crypto.randomUUID();
      let messageStarted = false;
      let assistantText = "";
      let previousResponseId =
        input.state &&
        typeof input.state === "object" &&
        typeof input.state.previousResponseId === "string"
          ? input.state.previousResponseId
          : "";

      const emit = (event: BaseEvent) => enqueue(sse(event));
      const emitText = (delta: string) => {
        if (!delta) return;
        if (!messageStarted) {
          emit({
            type: EventType.TEXT_MESSAGE_START,
            messageId,
            role: "assistant",
          });
          messageStarted = true;
        }
        assistantText += delta;
        emit({
          type: EventType.TEXT_MESSAGE_CONTENT,
          messageId,
          delta,
        });
      };
      // Thinking and tool activity travel as AG-UI custom events. Using the
      // standard tool-call events instead would append rows to the message
      // list, which is what the console persists and mines for deliverables.
      const emitActivity = (activity: ActivityEvent) =>
        emit({
          type: EventType.CUSTOM,
          name: ACTIVITY_EVENT_NAME,
          value: activity,
        } as BaseEvent);
      emit({
        type: EventType.RUN_STARTED,
        threadId: input.threadId,
        runId: input.runId,
      });

      try {
        const connection = resolveConnection(input.forwardedProps);
        const { attachments, reasoningEffort } = turnOptions(input.forwardedProps);
        const body: Record<string, unknown> = {
          model: connection.model,
          input: turnInput(latestUserText(input.messages), attachments),
          stream: true,
          store: true,
        };
        if (reasoningEffort) {
          body.reasoning = { effort: reasoningEffort };
        }
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
          ...(await resolveAuthHeaders(connection)),
        };

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
          emitText(text);
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
              const activity = activityFromUpstream(event);
              if (activity) emitActivity(activity);

              if (eventType === "response.output_text.delta") {
                const delta = typeof event.delta === "string" ? event.delta : "";
                emitText(delta);
              }
              if (eventType === "response.completed") {
                emitText(responseTextDelta(assistantText, response));
              }
              if (eventType === "error" || eventType === "response.failed") {
                throw upstreamError(event, upstream.status);
              }
            }
            if (done) break;
          }
        }

        if (!messageStarted) {
          throw new Error("Hosted Agent completed without assistant output.");
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
        const message =
          error instanceof Error ? error.message : "Agent request failed";
        emitActivity({ kind: "error", id: crypto.randomUUID(), message });
        emit({
          type: EventType.RUN_ERROR,
          message,
          code: "UPSTREAM_ERROR",
        });
      } finally {
        clearInterval(keepAliveTimer);
        if (streamOpen) {
          streamOpen = false;
          try {
            controller.close();
          } catch {
            // The downstream client already disconnected.
          }
        }
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
