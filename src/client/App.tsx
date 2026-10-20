import { useQueryClient } from "@tanstack/react-query";
import { createBrowserRouter, Navigate, NavLink, Outlet, useLocation, useNavigate } from "react-router";
import { api } from "./api";
import { Avatar, cx, Loading } from "./components/ui";
import { useMe } from "./hooks";
import { formatMoney } from "../shared/rules";
import AdminPage from "./pages/Admin";
import AdminInvitePage from "./pages/AdminInvite";
import AddGuestPage from "./pages/AddGuest";
import AnnouncementsPage from "./pages/Announcements";
import JoinPage from "./pages/Join";
import MePage from "./pages/Me";
import PayPage from "./pages/Pay";
import StatsPage from "./pages/Stats";
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
  { to: "/stats", label: "Stats", icon: "M5 20V10M12 20V4M19 20v-7" },
  { to: "/me", label: "Me", icon: "M16 8a4 4 0 1 1-8 0 4 4 0 0 1 8 0zM4 21c1-4 4-6 8-6s7 2 8 6", end: false },
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
  const items = NAV;
  const fines = data?.player?.outstandingFines ?? 0;
  const signOut = async () => {
    await api.post("/auth/sign-out", {}).catch(() => {});
    qc.clear();
    navigate("/signin");
  };
  return (
    <div className="min-h-dvh sm:px-6 sm:py-6 lg:px-10 lg:py-8">
      {/* The app lives in one white rounded panel over the pitch (full-bleed on phones). */}
      <div className="mx-auto min-h-dvh max-w-6xl bg-white pb-[calc(84px+env(safe-area-inset-bottom))] sm:min-h-[calc(100dvh-3rem)] sm:rounded-[var(--radius-panel)] sm:pb-10 sm:shadow-[0_30px_80px_-30px_rgba(0,0,0,0.5)]">
        <header className="sticky top-0 z-30 rounded-t-[var(--radius-panel)] bg-white/90 backdrop-blur">
          <div className="flex h-16 items-center gap-6 px-4 sm:h-20 sm:px-8">
            <NavLink to="/" className="flex items-center gap-2.5">
              <img src="/favicon.svg" alt="" className="size-8 rounded-full" />
              <span className="text-[17px] font-medium tracking-tight">{data?.groupName ?? "Team Alpha"}</span>
            </NavLink>
            <nav className="hidden items-center gap-6 md:flex" aria-label="Main">
              {[...items.filter((n) => n.to !== "/me"), { to: "/players", label: "Players", icon: "", end: false }].map((n) => (
                <NavLink
                  key={n.to}
                  to={n.to}
                  end={n.end}
                  className={({ isActive }) => cx("text-[15px] transition", isActive ? "font-medium text-ink" : "text-muted hover:text-ink")}
                >
                  {n.label}
                </NavLink>
              ))}
              <NavLink to="/announcements" className={({ isActive }) => cx("text-[15px]", isActive ? "font-medium text-ink" : "text-muted hover:text-ink")}>News</NavLink>
            </nav>
            <div className="ml-auto flex items-center gap-2">
              <NavLink to="/announcements" className="grid size-10 place-items-center rounded-full border border-line md:hidden" aria-label="News">📣</NavLink>
              {isAdmin && (
                <NavLink to="/admin" className={({ isActive }) => cx("inline-flex min-h-10 items-center rounded-full border px-4 text-sm font-medium", isActive ? "border-pitch-700 bg-pitch-700 text-white" : "border-pitch-700/40 text-pitch-800 hover:border-pitch-700")}>
                  Admin
                </NavLink>
              )}
              <NavLink to="/me" className="hidden items-center gap-2 rounded-full bg-pitch-700 py-1 pl-1 pr-4 text-sm font-medium text-white hover:bg-pitch-800 sm:inline-flex">
                <Avatar name={data?.player?.displayName ?? data?.user?.name ?? "?"} url={data?.player?.avatarUrl} size={32} />
                Me
              </NavLink>
              <button onClick={signOut} className="hidden min-h-10 rounded-full px-3 text-sm text-muted hover:text-ink lg:block">
                Sign out
              </button>
            </div>
          </div>
        </header>
        <div className="space-y-2 px-4 sm:px-8">
          {(data?.player?.renewal === "due_soon" || data?.player?.renewal === "overdue") && (
            <NavLink to="/me" className="flex items-center justify-between gap-3 rounded-2xl bg-sand-soft px-4 py-3 text-sm text-[#6b4a12]">
              <span>Membership renewal {data.player.renewal === "overdue" ? "is due" : "is due soon"}.</span>
              <span className="font-medium">Renew →</span>
            </NavLink>
          )}
          {fines > 0 && (
            <NavLink to="/me" className="flex items-center justify-between gap-3 rounded-2xl bg-red-50 px-4 py-3 text-sm text-ember">
              <span>You have {formatMoney(fines, data?.currency ?? "NGN")} in unpaid fines.</span>
              <span className="font-medium">Pay →</span>
            </NavLink>
          )}
        </div>
        <main className="px-4 pt-6 sm:px-8">
          <Outlet />
        </main>
      </div>
      <nav
        aria-label="Main"
        className="fixed inset-x-3 bottom-3 z-30 grid rounded-full border border-line bg-white/95 px-2 shadow-[0_10px_30px_-10px_rgba(0,0,0,0.35)] backdrop-blur sm:hidden"
        style={{ gridTemplateColumns: `repeat(${items.length}, minmax(0, 1fr))`, marginBottom: "env(safe-area-inset-bottom)" }}
      >
        {items.map((n) => (
          <NavLink
            key={n.to}
            to={n.to}
            end={n.end}
            className={({ isActive }) => cx("flex min-h-[60px] flex-col items-center justify-center gap-0.5 text-[11px]", isActive ? "font-medium text-pitch-700" : "text-muted")}
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
    <div className="min-h-dvh px-4 py-8 sm:py-14">
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
      { path: "/join/:token", element: <JoinPage /> },
      { path: "/r/:token", element: <JoinPage referral /> },
      { path: "/admin-invite/:token", element: <AdminInvitePage /> },
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
          { path: "/stats", element: <StatsPage /> },
          { path: "/stats/:seasonId", element: <StatsPage /> },
          { path: "/me", element: <MePage /> },
          { path: "/pay/:id", element: <PayPage /> },
          { path: "/announcements", element: <AnnouncementsPage /> },
          {
            element: <RequireUser admin />,
            children: [
              { path: "/matchdays/new", element: <NewMatchDayPage /> },
              { path: "/matchdays/:id/teams", element: <TeamSelectionPage /> },
              { path: "/matchdays/:id/live", element: <LiveResultsPage /> },
              { path: "/matchdays/:id/add-guest", element: <AddGuestPage /> },
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
