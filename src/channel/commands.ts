export type CommandName = "task" | "project" | "status" | "approve" | "reject" | "stop" | "costs";

export type ParsedMessage =
  | { kind: "command"; name: CommandName; args: string }
  | { kind: "free"; text: string };

const COMMANDS: Record<string, CommandName> = {
  "משימה": "task",
  "פרויקט": "project",
  "סטטוס": "status",
  "אשר": "approve",
  "דחה": "reject",
  "עצור": "stop",
  "עלויות": "costs",
};

/** Parses an owner message. The command word must be the first token; anything else is free text for the operator. */
export function parseMessage(raw: string): ParsedMessage {
  const text = raw.trim();
  const match = /^(\S+)(?:\s+([\s\S]*))?$/.exec(text);
  const name = match?.[1] ? COMMANDS[match[1]] : undefined;
  if (name) return { kind: "command", name, args: (match?.[2] ?? "").trim() };
  return { kind: "free", text };
}
