/** Receive: scan any Sealed code (or paste it) and route to the screen that handles it. */
import { Link, useNavigate } from "react-router";
import { Scanner } from "../components/Scanner";
import { PageTitle } from "../components/ui";
import { acceptedOrigins } from "../lib/config";
import { friendlyCodeError, routeCode } from "../lib/routing";

export function ReceivePage() {
  const navigate = useNavigate();
  return (
    <div className="stack-lg">
      <PageTitle eyebrow="Receive">Scan the code on their screen</PageTitle>
      <Scanner
        onCode={(text) => {
          try {
            const { path } = routeCode(text, acceptedOrigins());
            navigate(path);
            return null;
          } catch (e) {
            return friendlyCodeError(e);
          }
        }}
      />
      <div className="row">
        <Link to="/offline/receive" className="btn ghost">
          Receive offline
        </Link>
        <Link to="/broadcast/receive" className="btn ghost">
          Receive a broadcast
        </Link>
      </div>
    </div>
  );
}
