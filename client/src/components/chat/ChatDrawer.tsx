import { useEffect, useRef, useState } from "react";
import { Send, X } from "lucide-react";
import ReactMarkdown from "react-markdown";
import type { ActionCardProposal, ChatMessage, ChatMessageRecord } from "@dronetuner/shared";
import { apiGet } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import ActionCard from "./ActionCard";

interface DisplayMessage {
  role: "user" | "assistant";
  content: string;
  cards: ActionCardProposal[];
}

export default function ChatDrawer({ droneId, onClose }: { droneId?: number | null; onClose: () => void }) {
  const [messages, setMessages] = useState<DisplayMessage[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  // Hydrate the persisted conversation once (history survives drawer close).
  useEffect(() => {
    const q = droneId ? `?droneId=${droneId}` : "";
    void apiGet<ChatMessageRecord[]>(`/api/chat/messages${q}`)
      .then((rows) => {
        setMessages(
          rows.map((r) => ({
            role: r.role,
            content: r.content,
            cards: Array.isArray(r.toolCalls) ? (r.toolCalls as ActionCardProposal[]) : [],
          })),
        );
      })
      .catch(() => {});
  }, [droneId]);

  // Never leave a streaming request running when the drawer unmounts.
  useEffect(() => {
    return () => abortRef.current?.abort();
  }, []);

  const handleClose = () => {
    abortRef.current?.abort();
    onClose();
  };

  const appendToLast = (fn: (last: DisplayMessage) => void) => {
    setMessages((prev) => {
      if (prev.length === 0) return prev;
      const next = [...prev];
      const last = { ...next[next.length - 1]! };
      fn(last);
      next[next.length - 1] = last;
      return next;
    });
  };

  const send = async () => {
    const text = input.trim();
    if (!text || streaming) return;
    setInput("");
    const history: ChatMessage[] = [
      // The server requires non-empty content; drop card-only assistant turns.
      ...messages.map((m) => ({ role: m.role, content: m.content })).filter((m) => m.content.length > 0),
      { role: "user", content: text },
    ];
    setMessages((prev) => [
      ...prev,
      { role: "user", content: text, cards: [] },
      { role: "assistant", content: "", cards: [] },
    ]);
    setStreaming(true);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ droneId: droneId ?? null, messages: history }),
        signal: controller.signal,
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? `Chat request failed (${res.status})`);
      }
      if (!res.body) throw new Error("No response body");
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const blocks = buf.split("\n\n");
        buf = blocks.pop() ?? "";
        for (const block of blocks) {
          let event = "message";
          let data = "";
          for (const line of block.split("\n")) {
            if (line.startsWith("event: ")) event = line.slice(7);
            else if (line.startsWith("data: ")) data += line.slice(6);
          }
          if (!data) continue;
          let parsed: Record<string, unknown> = {};
          try {
            parsed = JSON.parse(data);
          } catch {
            continue;
          }
          if (event === "token") {
            const text2 = String(parsed.text ?? "");
            appendToLast((last) => {
              last.content += text2;
            });
          } else if (event === "action_card") {
            appendToLast((last) => {
              last.cards = [...last.cards, parsed.card as ActionCardProposal];
            });
          } else if (event === "error") {
            appendToLast((last) => {
              last.content += `\n\n> ${String(parsed.message ?? "error")}`;
            });
          }
        }
      }
    } catch (err) {
      if (!controller.signal.aborted) {
        appendToLast((last) => {
          last.content += `\n\n> ${err instanceof Error ? err.message : "Connection error"}`;
        });
      }
    } finally {
      setStreaming(false);
    }
  };

  return (
    <div className="fixed inset-y-0 right-0 z-40 flex w-[420px] flex-col border-l bg-card shadow-xl">
      <div className="flex h-14 items-center justify-between border-b px-4">
        <span className="font-semibold">Tuning copilot</span>
        <Button variant="ghost" size="icon" onClick={handleClose}>
          <X className="h-4 w-4" />
        </Button>
      </div>
      <ScrollArea className="flex-1 p-4">
        {messages.length === 0 && (
          <p className="text-sm text-muted-foreground">
            Ask about your fleet, blackbox findings, or tuning. The copilot proposes changes as confirmable action
            cards — it never writes to the FC by itself.
          </p>
        )}
        {messages.map((m, i) => (
          <div key={i} className="mb-3">
            {m.role === "user" ? (
              <div className="ml-auto w-fit max-w-[85%] rounded-lg bg-primary px-3 py-2 text-sm text-primary-foreground">
                {m.content}
              </div>
            ) : (
              <div className="max-w-[95%]">
                {m.content && (
                  <div className="prose prose-sm prose-invert max-w-none text-sm [&_p]:my-1 [&_ul]:my-1">
                    <ReactMarkdown>{m.content}</ReactMarkdown>
                  </div>
                )}
                {m.cards.map((c, j) => (
                  <ActionCard key={j} card={c} />
                ))}
              </div>
            )}
          </div>
        ))}
        {streaming && <div className={cn("text-xs text-muted-foreground")}>…</div>}
      </ScrollArea>
      <div className="flex gap-2 border-t p-3">
        <Textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Ask about your fleet, logs, or tuning…"
          rows={2}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
        />
        <Button onClick={() => void send()} disabled={streaming || !input.trim()} className="h-auto">
          <Send className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}
