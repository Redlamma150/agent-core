import { useApi } from "../hooks";
import { State } from "./common";

export function ProjectsScreen() {
  const active = useApi<{ name?: string } | null>("/projects/active");
  return (
    <>
      <h2>פרויקטים</h2>
      <State q={active}>{(p) => <div className="card">פרויקט פעיל: {p?.name ?? "אין"}</div>}</State>
    </>
  );
}
