import { useEffect, useState } from "react";
import { ConnectedContext, LiveContext, useApi, useRoute } from "./hooks";
import { api, consumeTokenFromHash, setUnauthorizedHandler, streamEvents, tokenStore } from "./lib/api";
import { ApprovalDetailScreen, ApprovalsScreen } from "./screens/Approvals";
import { ChatScreen } from "./screens/Chat";
import { InsightsScreen } from "./screens/Insights";
import { LoginScreen } from "./screens/Login";
import { NewTaskScreen } from "./screens/NewTask";
import { ProjectsScreen } from "./screens/Projects";
import { SettingsScreen } from "./screens/Settings";
import { TaskScreen } from "./screens/Task";
import { ListScreen, TasksScreen } from "./screens/Tasks";
import { Icon, type IconName } from "./ui";
import { UndoProvider, useUndo } from "./undo";

const TABS: { path: string; label: string; icon: IconName }[] = [
  { path: "/tasks", label: "משימות", icon: "tasks" },
  { path: "/approvals", label: "אישורים", icon: "approvals" },
  { path: "/chat", label: "מתפעל", icon: "chat" },
  { path: "/projects", label: "פרויקטים", icon: "projects" },
  { path: "/insights", label: "תובנות", icon: "insights" },
];

/** Screens that show the bottom bar. Every other screen is an inner one: back button on top, no bar. */
const MAIN = new Set(TABS.map((t) => t.path));
const pathOf = (route: string) => route.split("?")[0] ?? route;

export function App() {
  const [authed, setAuthed] = useState(() => {
    consumeTokenFromHash();
    return tokenStore.get() !== null;
  });
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

  const main = MAIN.has(pathOf(route));
  return (
    <LiveContext.Provider value={live}>
      <ConnectedContext.Provider value={connected}>
      <UndoProvider low={!main} onSettled={() => setLive((n) => n + 1)}>
        {!connected && <div className="banner" role="status">אין חיבור לליבה. מנסה להתחבר מחדש…</div>}
        <div className="screen">{screen(route, onLogout)}</div>
        {main && <BottomNav route={pathOf(route)} />}
      </UndoProvider>
      </ConnectedContext.Provider>
    </LiveContext.Provider>
  );
}

function BottomNav({ route }: { route: string }) {
  const approvals = useApi<{ id: number }[]>("/approvals");
  const { approvalHidden } = useUndo();
  const pending = (approvals.data ?? []).filter((a) => !approvalHidden(a.id)).length;
  return (
    <nav className="nav" aria-label="ניווט ראשי">
      {TABS.map((t) => (
        <a key={t.path} href={`#${t.path}`} aria-current={route === t.path ? "page" : undefined}>
          {t.path === "/approvals" && pending > 0 && <span className="badge" aria-label={`${pending} ממתינות`}>{pending}</span>}
          <Icon name={t.icon} size={22} />
          {t.label}
        </a>
      ))}
    </nav>
  );
}

function screen(route: string, onLogout: () => void) {
  const path = pathOf(route);
  const query = new URLSearchParams(route.split("?")[1] ?? "");
  if (path === "/new") {
    const project = Number(query.get("project"));
    return <NewTaskScreen projectId={project > 0 ? project : undefined} />;
  }
  if (path === "/list/archived") return <ListScreen view="archived" />;
  if (path === "/list/trash") return <ListScreen view="trash" />;
  const task = /^\/tasks\/(\d+)$/.exec(path);
  if (task?.[1]) return <TaskScreen id={Number(task[1])} />;
  const approval = /^\/approvals\/(\d+)$/.exec(path);
  if (approval?.[1]) return <ApprovalDetailScreen id={Number(approval[1])} />;
  if (path === "/approvals") return <ApprovalsScreen />;
  if (path === "/projects") return <ProjectsScreen />;
  if (path === "/insights" || path === "/usage") return <InsightsScreen />;
  if (path === "/chat") return <ChatScreen ask={query.get("q") ?? undefined} />;
  if (path === "/settings") return <SettingsScreen onLogout={onLogout} />;
  return <TasksScreen />;
}

// Re-exported so screens share one place for the request helper.
export { api };
