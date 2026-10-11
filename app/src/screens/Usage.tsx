import { useApi } from "../hooks";
import { formatNumber } from "../lib/format";
import { State } from "./common";

export function UsageScreen() {
  const usage = useApi<{ calls: number; input_tokens: number; output_tokens: number }>("/usage");
  return (
    <>
      <h2>צריכה</h2>
      <State q={usage}>
        {(u) => (
          <div className="card">
            <dl>
              <dt>קריאות למודל</dt><dd>{formatNumber(u.calls)}</dd>
              <dt>טוקני קלט</dt><dd>{formatNumber(u.input_tokens)}</dd>
              <dt>טוקני פלט</dt><dd>{formatNumber(u.output_tokens)}</dd>
            </dl>
          </div>
        )}
      </State>
    </>
  );
}
