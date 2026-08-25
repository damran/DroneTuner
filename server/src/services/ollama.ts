import type { ActionCardProposal, ChatMessage, ChatStreamEvent } from "@dronetuner/shared";

export interface ToolDef {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ToolCallResult {
  result: string;
  actionCard?: ActionCardProposal;
}

export interface ChatStreamOptions {
  url: string;
  model: string;
  messages: ChatMessage[];
  tools: ToolDef[];
  onToolCall: (name: string, args: unknown) => Promise<ToolCallResult>;
  maxIterations?: number;
  system?: string;
}

interface OllamaMessage {
  role: string;
  content: string;
  tool_calls?: { function: { name: string; arguments: unknown } }[];
  tool_name?: string;
}

/**
 * Ollama streams tool-call arguments as a JSON object (older versions sent a
 * JSON-encoded string). Normalize both shapes to an object.
 */
function normalizeToolArgs(args: unknown): unknown {
  if (args === null || args === undefined) return {};
  if (typeof args === "string") {
    try {
      return JSON.parse(args || "{}");
    } catch {
      return {};
    }
  }
  return args;
}

/**
 * Streams an Ollama /api/chat conversation with native tool calling.
 * Tool results are fed back by the caller via onToolCall.
 */
export async function* chatStream(opts: ChatStreamOptions): AsyncGenerator<ChatStreamEvent> {
  const { url, model, tools, onToolCall } = opts;
  const maxIterations = opts.maxIterations ?? 5;

  const messages: OllamaMessage[] = [];
  if (opts.system) messages.push({ role: "system", content: opts.system });
  for (const m of opts.messages) messages.push({ role: m.role, content: m.content });

  /** One streaming round-trip; yields tokens live, tool calls via `box`. */
  async function* round(
    withTools: boolean,
    box: { toolCalls: { name: string; args: unknown }[] },
  ): AsyncGenerator<ChatStreamEvent> {
    box.toolCalls = [];
    const response = await fetch(`${url}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, messages, tools: withTools ? tools : undefined, stream: true }),
      signal: AbortSignal.timeout(120_000),
    });

    if (!response.ok || !response.body) {
      const text = await response.text().catch(() => "");
      yield { type: "error", message: `Ollama error ${response.status}: ${text.slice(0, 300)}` };
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let content = "";
    const toolCalls: { name: string; args: unknown }[] = [];

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          let json: {
            message?: { content?: string; tool_calls?: { function: { name: string; arguments: unknown } }[] };
            done?: boolean;
          };
          try {
            json = JSON.parse(trimmed);
          } catch {
            continue;
          }
          if (json.message?.content) {
            content += json.message.content;
            yield { type: "token", text: json.message.content };
          }
          if (json.message?.tool_calls) {
            for (const tc of json.message.tool_calls) {
              toolCalls.push({ name: tc.function.name, args: normalizeToolArgs(tc.function.arguments) });
            }
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    if (toolCalls.length > 0) {
      messages.push({
        role: "assistant",
        content,
        tool_calls: toolCalls.map((tc) => ({ function: { name: tc.name, arguments: tc.args } })),
      });
    }
    box.toolCalls = toolCalls;
  }

  const box: { toolCalls: { name: string; args: unknown }[] } = { toolCalls: [] };
  let iter = 0;
  for (; iter < maxIterations; iter++) {
    let hadError = false;
    for await (const ev of round(true, box)) {
      if (ev.type === "error") hadError = true;
      yield ev;
    }
    if (hadError) return;
    const toolCalls = box.toolCalls;
    if (toolCalls.length === 0) {
      yield { type: "done" };
      return;
    }

    for (const tc of toolCalls) {
      let result: ToolCallResult;
      try {
        result = await onToolCall(tc.name, tc.args);
      } catch (err) {
        result = { result: `Tool ${tc.name} failed: ${String(err)}` };
      }
      if (result.actionCard) {
        yield { type: "action_card", card: result.actionCard };
      }
      messages.push({ role: "tool", tool_name: tc.name, content: result.result });
    }
  }

  // Tool-call budget exhausted — force a final answer without tools so the
  // user never gets an empty reply.
  for await (const ev of round(false, box)) yield ev;
  yield { type: "done" };
}
