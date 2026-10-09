/** App shell and routes. */
import { Suspense, lazy, useEffect, type ReactNode } from "react";
import { Link, NavLink, Outlet, createBrowserRouter, useNavigate, useRouteError } from "react-router";
import { BrandMark, Spinner } from "./components/ui";
import { attachInbox, refreshInbox, useInbox } from "./lib/inbox";
import { session, useSession } from "./lib/session";
import { ClaimPage } from "./routes/Claim";
import { ContactsPage } from "./routes/Contacts";
import { DevicesPage, AddDevicePage } from "./routes/Devices";
import { HomePage } from "./routes/Home";
import { InboxPage } from "./routes/Inbox";
import { OnboardingPage } from "./routes/Onboarding";
import { PairPage } from "./routes/Pair";
import { ReceivePage } from "./routes/Receive";
import { SecurityPage, SettingsPage } from "./routes/Settings";
import { SendToContactPage } from "./routes/SendToContact";
import { SharePage } from "./routes/Share";

// Optical modes (Facet encoder/decoder, RaptorQ) load on demand, keeping the claim page light for phone receivers.
const offline = () => import("./routes/Offline");
const OfflineHubPage = lazy(() => offline().then((m) => ({ default: m.OfflineHubPage })));
const ReceiveOfflinePage = lazy(() => offline().then((m) => ({ default: m.ReceiveOfflinePage })));
const SendOfflinePage = lazy(() => offline().then((m) => ({ default: m.SendOfflinePage })));
const BroadcastSendPage = lazy(() => offline().then((m) => ({ default: m.BroadcastSendPage })));
const BroadcastReceivePage = lazy(() => offline().then((m) => ({ default: m.BroadcastReceivePage })));

function Lazy({ children }: { children: ReactNode }) {
  return <Suspense fallback={<Spinner label="Loading…" />}>{children}</Suspense>;
}

function Shell() {
  const s = useSession();
  const inbox = useInbox();
  const navigate = useNavigate();

  useEffect(() => {
    session.start();
  }, []);

  useEffect(() => {
    attachInbox();
  }, [s.presence, s.active, s.keys]);

  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    const onMsg = (ev: MessageEvent) => {
      if ((ev.data as { type?: string } | null)?.type === "sealed-mailbox") void refreshInbox();
    };
    navigator.serviceWorker.addEventListener("message", onMsg);
    return () => navigator.serviceWorker.removeEventListener("message", onMsg);
  }, []);

  const pending = inbox.items.length + inbox.live.filter((l) => l.status !== "failed").length;

  return (
    <div className="shell">
      <a href="#main" className="skip-link">
        Skip to content
      </a>
      <header className="topbar">
        <Link to="/" className="brand" aria-label="Sealed home">
          <BrandMark />
          <span className={s.profile.fingerprint ? "brand-name" : undefined}>Sealed</span>
        </Link>
        {s.profile.fingerprint && (
          <nav className="topnav" aria-label="Main">
            <NavLink to="/" end>
              Home
            </NavLink>
            <NavLink to="/inbox">{pending > 0 ? `Inbox (${pending})` : "Inbox"}</NavLink>
            <NavLink to="/contacts">Contacts</NavLink>
            <NavLink to="/settings">Settings</NavLink>
          </nav>
        )}
        {!s.profile.fingerprint && s.status === "ready" && (
          <button type="button" className="btn small ghost" onClick={() => navigate("/welcome")}>
            Set up
          </button>
        )}
      </header>
      <main id="main" className="main">
        {s.status === "loading" && <Spinner label="Opening this device's keys…" />}
        {s.status === "error" && (
          <div className="notice danger" role="alert">
            Sealed could not open this browser's storage: {s.error}. Private windows and blocked site data prevent Sealed from keeping device keys.
          </div>
        )}
        {s.status === "ready" && <Outlet />}
      </main>
    </div>
  );
}

function RouteError() {
  const err = useRouteError();
  const message = err instanceof Error ? err.message : typeof err === "object" && err && "statusText" in err ? String((err as { statusText: unknown }).statusText) : "Something went wrong.";
  return (
    <div className="shell">
      <main className="main narrow stack">
        <h1>That did not work</h1>
        <p className="muted">{message}</p>
        <Link className="btn" to="/">
          Back to Sealed
        </Link>
      </main>
    </div>
  );
}

function NotFound() {
  return (
    <div className="stack">
      <h1>Nothing here</h1>
      <p className="muted">This page does not exist. If you scanned a code, it may be incomplete.</p>
      <Link className="btn" to="/">
        Go home
      </Link>
    </div>
  );
}

export const router = createBrowserRouter([
  {
    path: "/",
    element: <Shell />,
    errorElement: <RouteError />,
    children: [
      { index: true, element: <HomePage /> },
      { path: "welcome", element: <OnboardingPage /> },
      { path: "share", element: <SharePage /> },
      { path: "receive", element: <ReceivePage /> },
      // Code landing paths (packages/core protocol/codes.ts): a phone's camera app opens these directly.
      { path: "c/:transferId", element: <ClaimPage /> },
      { path: "p", element: <PairPage /> },
      { path: "d", element: <AddDevicePage /> },
      { path: "k", element: <Lazy><SendOfflinePage /></Lazy> },
      { path: "pair", element: <PairPage /> },
      { path: "contacts", element: <ContactsPage /> },
      { path: "contacts/:fp/send", element: <SendToContactPage /> },
      { path: "inbox", element: <InboxPage /> },
      { path: "devices", element: <DevicesPage /> },
      { path: "devices/add", element: <AddDevicePage /> },
      { path: "offline", element: <Lazy><OfflineHubPage /></Lazy> },
      { path: "offline/receive", element: <Lazy><ReceiveOfflinePage /></Lazy> },
      { path: "offline/send", element: <Lazy><SendOfflinePage /></Lazy> },
      { path: "broadcast", element: <Lazy><BroadcastSendPage /></Lazy> },
      { path: "broadcast/receive", element: <Lazy><BroadcastReceivePage /></Lazy> },
      { path: "settings", element: <SettingsPage /> },
      { path: "security", element: <SecurityPage /> },
      { path: "*", element: <NotFound /> },
    ],
  },
]);
