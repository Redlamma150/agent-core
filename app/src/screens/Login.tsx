import { useState, type FormEvent } from "react";
import { api, ApiError, tokenStore } from "../lib/api";

export function LoginScreen({ onDone }: { onDone: () => void }) {
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api("/usage", { token: value.trim() }); // any authenticated route proves the token is right
      tokenStore.set(value.trim());
      onDone();
    } catch (err) {
      setError(err instanceof ApiError && err.status === 401 ? "הטוקן שגוי." : "אין חיבור לליבה.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="login">
      <h1>מערכת סוכנים</h1>
      <form onSubmit={submit}>
        <label htmlFor="token">טוקן גישה</label>
        <input id="token" type="password" autoComplete="off" dir="ltr" value={value} onChange={(e) => setValue(e.target.value)} required />
        {error && <p className="error" role="alert">{error}</p>}
        <button className="primary" disabled={busy || value.trim() === ""}>{busy ? "בודק…" : "כניסה"}</button>
        <p className="muted">הטוקן נשמר במכשיר הזה בלבד.</p>
      </form>
    </main>
  );
}
