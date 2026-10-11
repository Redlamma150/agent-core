import { useEffect, useState } from "react";
import { disablePush, enablePush, pushEnabled, pushSupported } from "../lib/push";

export function SettingsScreen({ onLogout }: { onLogout: () => void }) {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void pushEnabled().then(setEnabled, () => setEnabled(false));
  }, []);

  async function toggle() {
    setError(null);
    try {
      if (enabled) await disablePush();
      else await enablePush();
      setEnabled(await pushEnabled());
    } catch (err) {
      setError((err as Error).message === "denied" ? "ההרשאה להתראות נדחתה. אפשר לשנות אותה בהגדרות המכשיר." : "לא הצלחתי לעדכן את ההתראות.");
    }
  }

  return (
    <>
      <h2>הגדרות</h2>
      <div className="card">
        <h3>התראות</h3>
        {!pushSupported() ? (
          <p className="muted">המכשיר לא תומך בהתראות. באייפון צריך קודם להוסיף את האפליקציה למסך הבית.</p>
        ) : (
          <>
            <p>{enabled ? "ההתראות פעילות במכשיר הזה." : "ההתראות כבויות במכשיר הזה."}</p>
            <button className="primary" onClick={toggle} disabled={enabled === null}>{enabled ? "כבה התראות" : "הפעל התראות"}</button>
          </>
        )}
        {error && <p className="error" role="alert">{error}</p>}
      </div>
      <div className="card">
        <h3>חשבון</h3>
        <button className="danger" onClick={onLogout}>התנתק ומחק טוקן מהמכשיר</button>
      </div>
    </>
  );
}
