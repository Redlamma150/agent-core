import { useApi } from "../hooks";
import { formatNumber } from "../lib/format";
import { TopBar } from "../ui";
import { State } from "./common";

interface Window { calls: number; input_tokens: number; output_tokens: number }
interface Usage extends Window {
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
                <div className="card">
                  <h2 className="h2">חלון 5 השעות</h2>
                  <div className="big-num">{formatNumber(total(u.last_5h))} טוקנים</div>
                  <div className="bar" aria-hidden="true"><span style={{ width: `${share}%` }} /></div>
                  <div className="muted">{formatNumber(u.last_5h.calls)} קריאות למודל. הפס מראה כמה מהשבוע נוצל ב-5 השעות האחרונות. המערכת סופרת רק מה שהיא הריצה, ו-Claude לא מדווח כמה נשאר במנוי.</div>
                </div>
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
                <h2 className="h2">הצעות ייעול</h2>
                <div className="card center soon"><div className="muted">הצעות לחיסכון בצריכה יופיעו כאן, עם כפתור להחלה. <span className="soon-tag">בקרוב</span></div></div>
              </>
            );
          }}
        </State>
      </div>
    </>
  );
}
