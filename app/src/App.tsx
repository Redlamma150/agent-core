import { useEffect, useState } from "react";
import { LiveContext, useApi, useRoute } from "./hooks";
import { api, setUnauthorizedHandler, streamEvents, tokenStore } from "./lib/api";
import { ApprovalsScreen } from "./screens/Approvals";
import { ChatScreen } from "./screens/Chat";
import { LoginScreen } from "./screens/Login";
import { ProjectsScreen } from "./screens/Projects";
import { SettingsScreen } from "./screens/Settings";
import { TaskScreen } from "./screens/Task";
import { TasksScreen } from "./screens/Tasks";
import { UsageScreen } from "./screens/Usage";

const TABS = [
  { path: "/tasks", label: "משימות", icon: "☰" },
  { path: "/approvals", label: "אישורים", icon: "✓" },
  { path: "/projects", label: "פרויקטים", icon: "▣" },
  { path: "/usage", label: "צריכה", icon: "◔" },
  { path: "/chat", label: "צ'אט", icon: "✎" },
];

export function App() {
  const [authed, setAuthed] = useState(() => tokenStore.get() !== null);
  useEffect(() => setUnauthorizedHandler(() => {
    tokenStore.clear();
    setAuthed(false);
  }), []);

  if (!authed) return <LoginScreen onDone={() => setAuthed(true)} />;
  return <Shell onLogout={() => { tokenStore.clear(); setAuthed(false); }} />;
}

function Shell({ onLogout }: { onLogout: () => void }) {
  const route = useRoute();
  const [live, setLive] = useState(0);
  const [connected, setConnected] = useState(true);

  useEffect(() => {
    const abort = new AbortController();
    void streamEvents(() => setLive((n) => n + 1), abort.signal, setConnected);
    return () => abort.abort();
  }, []);

  return (
    <LiveContext.Provider value={live}>
      <header className="topbar">
        <h1>מערכת סוכנים</h1>
        <span className={connected ? "dot ok" : "dot bad"} role="status" aria-label={connected ? "מחובר" : "אין חיבור"} />
        <a className="icon-btn" href="#/settings" aria-label="הגדרות">⚙</a>
      </header>
      {!connected && <div className="banner">אין חיבור לליבה. מנסה להתחבר מחדש…</div>}
      <main>{screen(route, onLogout)}</main>
      <nav className="tabbar" aria-label="ניווט ראשי">
        {TABS.map((t) => (
          <a key={t.path} href={`#${t.path}`} aria-current={route.startsWith(t.path) ? "page" : undefined}>
            <span aria-hidden="true">{t.icon}</span>
            <span>{t.label}</span>
            {t.path === "/approvals" && <PendingBadge />}
          </a>
        ))}
      </nav>
    </LiveContext.Provider>
  );
}

function PendingBadge() {
  const { data } = useApi<unknown[]>("/approvals");
  return data && data.length > 0 ? <span className="badge">{data.length}</span> : null;
}

function screen(route: string, onLogout: () => void) {
  const task = /^\/tasks\/(\d+)$/.exec(route);
  if (task?.[1]) return <TaskScreen id={Number(task[1])} />;
  if (route.startsWith("/approvals")) return <ApprovalsScreen />;
  if (route.startsWith("/projects")) return <ProjectsScreen />;
  if (route.startsWith("/usage")) return <UsageScreen />;
  if (route.startsWith("/chat")) return <ChatScreen />;
  if (route.startsWith("/settings")) return <SettingsScreen onLogout={onLogout} />;
  return <TasksScreen />;
}

// Re-exported so screens share one place for the request helper.
export { api };
