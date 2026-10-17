import { useApi, useConnected } from "../hooks";
import { api } from "../lib/api";
import { clockTime, formatNumber, type Quota } from "../lib/format";
import { TopBar } from "../ui";
import { useUndo } from "../undo";
import { errorText, State } from "./common";

interface Tip { id: string; title: string; body: string; gain: string; applied: boolean }

/** Suggestions from what the system actually ran. Applying one has the 5 second undo window; an applied one can be switched off. */
function Tips() {
  const tips = useApi<Tip[]>("/insights");
  const { schedule, isPending, notify } = useUndo();
  const connected = useConnected();
  async function switchOff(id: string) {
    try {
      await api(`/insights/${id}/unapply`, { method: "POST", body: {} });
      tips.reload();
    } catch (err) {
      notify(errorText(err));
    }
  }
  return (
    <>
      <h2 className="h2">הצעות ייעול</h2>
      <State q={tips}>
        {(list) => list.length === 0 ? (
          <div className="card center"><div className="muted">אין הצעות כרגע. הן מבוססות על מה שהמערכת הריצה, ויופיעו כשיהיה מספיק מידע.</div></div>
        ) : list.map((t) => {
          const waiting = isPending(`insight:${t.id}`);
          const on = t.applied || waiting;
          return (
            <div key={t.id} className="card">
              <div className="ttl">{t.title}</div>
              <p className="txt">{t.body}</p>
              <div className="row between wrap">
                <span className="muted">{t.gain}</span>
                <div className="row">
                  {t.applied && !waiting && <button type="button" className="btn ghost sm" disabled={!connected} onClick={() => void switchOff(t.id)}>בטל החלה</button>}
                  <button
                    type="button"
                    className={`btn sm ${on ? "" : "pri"}`}
                    disabled={on || !connected}
                    onClick={() => schedule({ key: `insight:${t.id}`, text: "ההצעה הוחלה", commit: () => api(`/insights/${t.id}/apply`, { method: "POST", body: {} }), onError: errorText })}
                  >{on ? "הוחל" : "החל"}</button>
                </div>
              </div>
            </div>
          );
        })}
      </State>
    </>
  );
}

interface Window { calls: number; input_tokens: number; output_tokens: number }
interface Usage extends Window {
  quota: Quota | null;
  last_5h: Window; last_24h: Window; last_7d: Window;
  top_tasks: { id: number; title: string | null; tokens: number }[];
}

const total = (w: Window) => w.input_tokens + w.output_tokens;

export function InsightsScreen() {
  const usage = useApi<Usage>("/usage");
  return (
    <>
      <TopBar title="תובנות" />
      <div className="body has-nav">
        <State q={usage}>
          {(u) => {
            const week = Math.max(total(u.last_7d), 1);
            const share = Math.min(100, Math.round((total(u.last_5h) / week) * 100));
            return (
              <>
                {u.quota?.five_hour ? (
                  <div className="card">
                    <div className="row between"><h2 className="h2">חלון 5 השעות</h2><span className="muted">מתחדש ב-{clockTime(u.quota.five_hour.resets_at)}</span></div>
                    <div className="big-num">{Math.round(u.quota.five_hour.percent)}%</div>
                    <div className="bar" role="img" aria-label={`${Math.round(u.quota.five_hour.percent)} אחוז מחלון 5 השעות נוצלו`}><span style={{ width: `${Math.min(100, u.quota.five_hour.percent)}%` }} /></div>
                    {u.quota.seven_day && <div className="row between"><span className="muted">השבוע</span><span style={{ fontSize: 14 }}>{Math.round(u.quota.seven_day.percent)}% · מתחדש {new Date(u.quota.seven_day.resets_at).toLocaleDateString("he-IL", { weekday: "long" })}</span></div>}
                    <div className="muted">הנתון מגיע מהמנוי עצמו ומתעדכן בכל הרצה של סוכן. {formatNumber(total(u.last_5h))} טוקנים ב-{formatNumber(u.last_5h.calls)} קריאות הרצנו ב-5 השעות האחרונות.</div>
                  </div>
                ) : (
                  <div className="card">
                    <h2 className="h2">חלון 5 השעות</h2>
                    <div className="big-num">{formatNumber(total(u.last_5h))} טוקנים</div>
                    <div className="bar" aria-hidden="true"><span style={{ width: `${share}%` }} /></div>
                    <div className="muted">{formatNumber(u.last_5h.calls)} קריאות למודל. הפס מראה כמה מהשבוע נוצל ב-5 השעות האחרונות. אחוז המכסה האמיתי יופיע אחרי הרצה הבאה של סוכן.</div>
                  </div>
                )}
                <div className="card">
                  <h2 className="h2">לפי ספק, השבוע</h2>
                  <div className="row between"><span className="ai">Claude</span><span style={{ fontSize: 14 }}>{formatNumber(total(u.last_7d))} טוקנים · במנוי</span></div>
                  <div className="row between"><span className="ai">GPT</span><span className="muted">לא מחובר</span></div>
                </div>
                <div className="card">
                  <dl>
                    <dt>24 שעות</dt><dd>{formatNumber(total(u.last_24h))}</dd>
                    <dt>7 ימים</dt><dd>{formatNumber(total(u.last_7d))}</dd>
                    <dt>הכול</dt><dd>{formatNumber(total(u))}</dd>
                    <dt>קריאות בסך הכול</dt><dd>{formatNumber(u.calls)}</dd>
                  </dl>
                </div>
                {u.top_tasks.length > 0 && (
                  <div className="card">
                    <h2 className="h2">המשימות הכבדות השבוע</h2>
                    {u.top_tasks.map((t) => (
                      <a key={t.id} className="row between tap" style={{ minHeight: 44 }} href={`#/tasks/${t.id}`}><span className="grow clamp2"><span className="mono">#{t.id}</span> {t.title ?? ""}</span><span>{formatNumber(t.tokens)}</span></a>
                    ))}
                  </div>
                )}
                <Tips />
              </>
            );
          }}
        </State>
      </div>
    </>
  );
}
