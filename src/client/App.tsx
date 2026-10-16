import { useQueryClient } from "@tanstack/react-query";
import { createBrowserRouter, Navigate, NavLink, Outlet, useLocation, useNavigate } from "react-router";
import { api } from "./api";
import { cx, Loading } from "./components/ui";
import { useMe } from "./hooks";
import AdminPage from "./pages/Admin";
import DashboardPage from "./pages/Dashboard";
import GuestRegisterPage from "./pages/GuestRegister";
import InvitePage from "./pages/Invite";
import LiveResultsPage from "./pages/LiveResults";
import MatchDayDetailPage from "./pages/MatchDayDetail";
import MatchDaysPage from "./pages/MatchDays";
import NewMatchDayPage from "./pages/NewMatchDay";
import PlayerProfilePage from "./pages/PlayerProfile";
import PlayersPage from "./pages/Players";
import RulesPage from "./pages/Rules";
import SetupPage from "./pages/Setup";
import SignInPage from "./pages/SignIn";
import StandingsPage from "./pages/Standings";
import TeamSelectionPage from "./pages/TeamSelection";

function RequireUser({ admin = false }: { admin?: boolean }) {
  const { data, isLoading, error } = useMe();
  const location = useLocation();
  if (isLoading) return <Loading />;
  if (error) return <div className="p-6 text-red-700">Could not reach the server. Pull to refresh.</div>;
  if (data?.needsSetup) return <Navigate to="/setup" replace />;
  if (!data?.user) return <Navigate to={`/signin?next=${encodeURIComponent(location.pathname)}`} replace />;
  if (admin && data.user.role !== "admin") return <Navigate to="/" replace />;
  return <Outlet />;
}

const NAV = [
  { to: "/", label: "Home", icon: "M3 11l9-8 9 8v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z", end: true },
  { to: "/matchdays", label: "Matches", icon: "M4 5h16v14H4zM12 5v14M4 12h3M17 12h3" },
  { to: "/standings", label: "Table", icon: "M4 6h16M4 12h16M4 18h10" },
  { to: "/players", label: "Players", icon: "M16 11a4 4 0 1 0-8 0 4 4 0 0 0 8 0zM4 21c1-4 4-6 8-6s7 2 8 6" },
];

function Icon({ d }: { d: string }) {
  return (
    <svg viewBox="0 0 24 24" className="size-6" fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d={d} />
    </svg>
  );
}

function Layout() {
  const { data } = useMe();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const isAdmin = data?.user?.role === "admin";
  const items = isAdmin ? [...NAV, { to: "/admin", label: "Admin", icon: "M12 3l8 4v5c0 5-3.5 8-8 9-4.5-1-8-4-8-9V7z", end: false }] : NAV;
  const signOut = async () => {
    await api.post("/auth/sign-out", {}).catch(() => {});
    qc.clear();
    navigate("/signin");
  };
  return (
    <div className="min-h-dvh pb-[calc(76px+env(safe-area-inset-bottom))] sm:pb-10">
      <header className="sticky top-0 z-30 bg-pitch-900 text-white shadow-md">
        <div className="mx-auto flex h-14 max-w-5xl items-center gap-4 px-4">
          <NavLink to="/" className="flex items-center gap-2">
            <img src="/favicon.svg" alt="" className="size-8 rounded-lg ring-1 ring-white/20" />
            <span className="display text-2xl font-bold uppercase tracking-wide">{data?.groupName ?? "Matchday"}</span>
          </NavLink>
          <nav className="ml-6 hidden gap-1 sm:flex" aria-label="Main">
            {items.map((n) => (
              <NavLink
                key={n.to}
                to={n.to}
                end={n.end}
                className={({ isActive }) => cx("rounded-lg px-3 py-2 text-sm font-semibold", isActive ? "bg-white/15 text-white" : "text-pitch-100 hover:bg-white/10")}
              >
                {n.label}
              </NavLink>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-2 text-sm">
            <NavLink to="/rules" className="rounded-lg px-2 py-2 font-semibold text-pitch-100 hover:bg-white/10">
              Rules
            </NavLink>
            <button onClick={signOut} className="rounded-lg px-2 py-2 font-semibold text-pitch-100 hover:bg-white/10">
              Sign out
            </button>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-5xl px-4 pt-5">
        <Outlet />
      </main>
      <nav
        aria-label="Main"
        className="fixed inset-x-0 bottom-0 z-30 grid border-t border-line bg-white/95 pb-[env(safe-area-inset-bottom)] backdrop-blur sm:hidden"
        style={{ gridTemplateColumns: `repeat(${items.length}, minmax(0, 1fr))` }}
      >
        {items.map((n) => (
          <NavLink
            key={n.to}
            to={n.to}
            end={n.end}
            className={({ isActive }) => cx("flex min-h-[64px] flex-col items-center justify-center gap-0.5 text-[11px] font-semibold", isActive ? "text-pitch-700" : "text-muted")}
          >
            <Icon d={n.icon} />
            {n.label}
          </NavLink>
        ))}
      </nav>
    </div>
  );
}

function PublicShell() {
  return (
    <div className="min-h-dvh bg-[radial-gradient(ellipse_at_top,var(--color-pitch-800),var(--color-pitch-950)_70%)] px-4 py-8 sm:py-14">
      <div className="mx-auto max-w-md">
        <Outlet />
      </div>
    </div>
  );
}

export const router = createBrowserRouter([
  {
    element: <PublicShell />,
    children: [
      { path: "/signin", element: <SignInPage /> },
      { path: "/setup", element: <SetupPage /> },
      { path: "/invite/:token", element: <InvitePage /> },
      { path: "/g/:token", element: <GuestRegisterPage /> },
    ],
  },
  {
    element: <RequireUser />,
    children: [
      {
        element: <Layout />,
        children: [
          { path: "/", element: <DashboardPage /> },
          { path: "/rules", element: <RulesPage /> },
          { path: "/matchdays", element: <MatchDaysPage /> },
          { path: "/matchdays/:id", element: <MatchDayDetailPage /> },
          { path: "/standings", element: <StandingsPage /> },
          { path: "/standings/:seasonId", element: <StandingsPage /> },
          { path: "/players", element: <PlayersPage /> },
          { path: "/players/:id", element: <PlayerProfilePage /> },
          {
            element: <RequireUser admin />,
            children: [
              { path: "/matchdays/new", element: <NewMatchDayPage /> },
              { path: "/matchdays/:id/teams", element: <TeamSelectionPage /> },
              { path: "/matchdays/:id/live", element: <LiveResultsPage /> },
              { path: "/admin", element: <AdminPage /> },
              { path: "/admin/:tab", element: <AdminPage /> },
            ],
          },
          { path: "*", element: <Navigate to="/" replace /> },
        ],
      },
    ],
  },
]);
