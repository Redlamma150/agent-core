import { useEffect, useState } from "react";
import { disablePush, enablePush, pushEnabled, pushSupported } from "../lib/push";
import { useApi } from "../hooks";
import { api } from "../lib/api";
import { InnerBar, Toggle } from "../ui";
import { useUndo } from "../undo";

/** Gemini is off and hidden by default, and stays out of every other screen. It has no switch here until the core supports it. */
export function SettingsScreen({ onLogout }: { onLogout: () => void }) {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const { notify } = useUndo();
  const core = useApi<{ auto_stash: boolean }>("/settings");

  useEffect(() => {
    void pushEnabled().then(setEnabled, () => setEnabled(false));
  }, []);

  async function toggle() {
    try {
      if (enabled) await disablePush();
      else await enablePush();
      setEnabled(await pushEnabled());
    } catch (err) {
      notify((err as Error).message === "denied" ? "ההרשאה להתראות נדחתה. אפשר לשנות אותה בהגדרות המכשיר." : "לא הצלחתי לעדכן את ההתראות.");
    }
  }

  return (
    <>
      <InnerBar fallback="/tasks" />
      <div className="body">
        <h1 className="h1s">הגדרות</h1>

        <h2 className="h2">ספקי AI</h2>
        <div className="card" style={{ gap: 12 }}>
          <div className="row between"><div><div className="ttl">Claude</div><div className="muted">מחובר דרך המנוי במחשב</div></div><span className="pill p-done">מחובר</span></div>
          <div className="row between"><div><div className="ttl">GPT</div><div className="muted">לחוות דעת שנייה על קוד</div></div><span className="soon-tag">בקרוב</span></div>
        </div>

        <h2 className="h2">התראות ואוטומציה</h2>
        <div className="card" style={{ gap: 14 }}>
          {pushSupported()
            ? <Toggle label="התראות במכשיר הזה" sub="בקשת אישור חדשה, משימה שנתקעה, נעצרה או מוזגה" checked={enabled === true} onChange={enabled === null ? undefined : toggle} />
            : <div className="muted">המכשיר לא תומך בהתראות. באייפון צריך קודם להוסיף את האפליקציה למסך הבית.</div>}
          <Toggle label="סיכום יומי" sub="הודעה אחת בסוף היום" checked={false} soon />
          <Toggle label="המשך אוטומטי אחרי מכסה" sub="משימה שהושהתה תמשיך כשהמכסה מתחדשת" checked={false} soon />
          <Toggle
            label="שמור שינויים בצד לפני מיזוג"
            sub="שינויים שלא נשמרו בפרויקט לא יעצרו מיזוג. הם חוזרים אחריו"
            checked={core.data?.auto_stash === true}
            onChange={core.data === null ? undefined : () => api("/settings", { method: "PUT", body: { auto_stash: !core.data?.auto_stash } }).then(core.reload, () => notify("לא הצלחתי לעדכן את ההגדרה."))}
          />
          <Toggle label="עצור משימה שתקועה 45 דקות" sub="כבר פעיל תמיד. ניתן להגדרה בקובץ ההגדרות של הליבה" checked={true} soon />
        </div>

        <button type="button" className="btn dan" onClick={onLogout}>התנתק ומחק טוקן מהמכשיר</button>
      </div>
    </>
  );
}
