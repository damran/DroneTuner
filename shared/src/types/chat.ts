import type { ProfileSettings } from "./fc";

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export type ActionCardKind = "apply_profile" | "pid_change";

export interface ActionCardProposal {
  kind: ActionCardKind;
  droneId: number;
  title: string;
  rationale: string;
  /** apply_profile: existing profile to apply */
  profileId?: number;
  profileName?: string;
  /** pid_change: draft settings to apply as a one-off change */
  settings?: ProfileSettings;
}

/** Server-sent events emitted by POST /api/chat. */
export type ChatStreamEvent =
  | { type: "token"; text: string }
  | { type: "action_card"; card: ActionCardProposal }
  | { type: "done" }
  | { type: "error"; message: string };

export interface ChatRequest {
  droneId?: number | null;
  messages: ChatMessage[];
}
