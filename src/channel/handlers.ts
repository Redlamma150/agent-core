import type { Db } from "../db/index.js";
import type { ParsedMessage } from "./commands.js";
import type { ChannelHandlers } from "./whatsapp.js";

const STATUS_LABELS: Record<string, string> = {
  received: "התקבלה",
  planning: "בתכנון",
  in_progress: "בביצוע",
  awaiting_approval: "ממתינה לאישור",
  merged: "מוזגה",
  blocked: "חסומה",
  stopped: "עצורה",
};

export function statusReply(db: Db): string {
  const rows = db.prepare("SELECT status, COUNT(*) AS n FROM tasks GROUP BY status").all() as { status: string; n: number }[];
  if (rows.length === 0) return "המערכת פעילה. אין משימות.";
  const lines = rows.map((r) => `${STATUS_LABELS[r.status] ?? r.status}: ${r.n}`);
  return `המערכת פעילה.\n${lines.join("\n")}`;
}

/** M2 handlers: only `סטטוס` is live. The rest are acknowledged until M3-M5 wire them up. */
export function createHandlers(db: Db): ChannelHandlers {
  return {
    onMessage(msg: ParsedMessage) {
      if (msg.kind === "free") return "ההודעה התקבלה ותועבר למתפעל.";
      if (msg.name === "status") return statusReply(db);
      return "הפקודה התקבלה אך עדיין לא מחוברת.";
    },
  };
}
