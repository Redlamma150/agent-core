import { useApi } from "../hooks";
import { formatNumber } from "../lib/format";
import { State } from "./common";

interface Window { calls: number; input_tokens: number; output_tokens: number }
interface Usage extends Window {
  last_5h: Window; last_24h: Window; last_7d: Window;
  top_tasks: { id: number; title: string | null; tokens: number }[];
}

const total = (w: Window) => w.input_tokens + w.output_tokens;

export function UsageScreen() {
  const usage = useApi<Usage>("/usage");
  return (
    <>
      <h2>צריכה</h2>
      <State q={usage}>
        {(u) => {
          const week = Math.max(total(u.last_7d), 1);
          return (
            <>
              <div className="card meter">
                <span className="muted small">ב-5 השעות האחרונות</span>
                <span className="big">{formatNumber(total(u.last_5h))}</span>
                <span className="muted small">טוקנים · {formatNumber(u.last_5h.calls)} קריאות למודל</span>
                <div className="bar" aria-hidden="true"><i style={{ width: `${Math.min(100, Math.round((total(u.last_5h) / week) * 100))}%` }} /></div>
                <span className="muted small">המנוי מגביל את השימוש בחלונות זמן. הפס מראה כמה מהשבוע נוצל ב-5 השעות האחרונות.</span>
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
                  <h3>המשימות הכבדות השבוע</h3>
                  <ul className="list">
                    {u.top_tasks.map((t) => (
                      <li key={t.id} className="row between"><a className="grow" href={`#/tasks/${t.id}`}>#{t.id} {t.title ?? ""}</a><span>{formatNumber(t.tokens)}</span></li>
                    ))}
                  </ul>
                </div>
              )}
            </>
          );
        }}
      </State>
    </>
  );
}
