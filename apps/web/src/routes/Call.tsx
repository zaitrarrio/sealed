/**
 * Paired call UI: place a call to a contact, or accept an incoming call. Refuses when encoded-frame
 * encryption is unavailable (ADR-0013).
 */
import { useEffect, useRef, useState } from "react";
import { Link, Navigate, useParams } from "react-router";
import { Notice, PageTitle, errorMessage } from "../components/ui";
import { CallError, placeCall, startCallReceiver, supportsEncodedFrameEncryption, type CallHandle } from "../lib/call";
import { cachedChain, getContact, type ContactRecord } from "../lib/contacts-store";
import { useSession } from "../lib/session";

export function CallContactPage() {
  const s = useSession();
  const { fp = "" } = useParams();
  const [contact, setContact] = useState<ContactRecord | null | undefined>(undefined);
  const [status, setStatus] = useState<"idle" | "calling" | "in-call" | "ended">("idle");
  const [error, setError] = useState<string | null>(null);
  const handleRef = useRef<CallHandle | null>(null);
  const remoteAudio = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    void getContact(fp).then((c) => setContact(c ?? null));
  }, [fp]);

  useEffect(
    () => () => {
      void handleRef.current?.hangup();
    },
    [],
  );

  if (!s.profile.fingerprint) return <Navigate to="/welcome" replace />;
  if (contact === null) return <Navigate to="/contacts" replace />;
  if (contact === undefined) return null;

  const online = s.presence?.online.get(fp) ?? 0;
  const canCall = supportsEncodedFrameEncryption();

  return (
    <div className="stack-lg">
      <PageTitle eyebrow="Call">Call {contact.displayName}</PageTitle>
      {!canCall && <Notice tone="danger">This browser cannot encrypt call audio end-to-end. Sealed refuses SRTP-only calls.</Notice>}
      {contact.blocked && <Notice tone="danger">{contact.blocked.reason}</Notice>}
      {status === "idle" && (
        <>
          <p className="subtle">{online > 0 ? "They have a device online." : "They appear offline — the call may not connect."}</p>
          <button
            type="button"
            className="btn primary"
            data-testid="place-call"
            disabled={!canCall || !!contact.blocked || !s.active || !s.presence || !s.client || !s.keys}
            onClick={() => {
              const chain = cachedChain(contact);
              if (!chain || !s.client || !s.presence || !s.keys) return;
              setStatus("calling");
              setError(null);
              placeCall({
                client: s.client,
                presence: s.presence,
                keys: s.keys,
                recipient: chain,
                onRemoteStream: (stream) => {
                  if (remoteAudio.current) {
                    remoteAudio.current.srcObject = stream;
                    void remoteAudio.current.play().catch(() => undefined);
                  }
                },
              })
                .then((h) => {
                  handleRef.current = h;
                  setStatus("in-call");
                })
                .catch((e: unknown) => {
                  setError(e instanceof CallError ? e.message : errorMessage(e));
                  setStatus("idle");
                });
            }}
          >
            Call
          </button>
        </>
      )}
      {status === "calling" && <p className="muted">Calling…</p>}
      {(status === "calling" || status === "in-call") && (
        <button
          type="button"
          className="btn"
          data-testid="hangup-call"
          onClick={() => {
            void handleRef.current?.hangup().then(() => {
              handleRef.current = null;
              setStatus("ended");
            });
          }}
        >
          Hang up
        </button>
      )}
      {status === "ended" && <p className="subtle">Call ended.</p>}
      {error && <Notice tone="danger">{error}</Notice>}
      <audio ref={remoteAudio} autoPlay playsInline data-testid="call-remote-audio" />
      <Link to={`/contacts/${fp}/send`} className="btn ghost">
        Send files instead
      </Link>
    </div>
  );
}

/** Mounts a global incoming-call listener while the session is active. */
export function CallIncomingHost() {
  const s = useSession();
  const [incoming, setIncoming] = useState<{ id: string; name: string; accept: () => Promise<CallHandle>; decline: () => void } | null>(null);
  const [active, setActive] = useState<CallHandle | null>(null);
  const remoteAudio = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    if (!s.client || !s.presence || !s.keys || !supportsEncodedFrameEncryption()) return;
    const stop = startCallReceiver({
      client: s.client,
      presence: s.presence,
      keys: s.keys,
      resolveSender: async (fp) => {
        const c = await getContact(fp);
        if (!c || c.blocked) return null;
        const chain = cachedChain(c);
        if (!chain) return null;
        return { chain, displayName: c.displayName };
      },
      onIncoming: (info) => setIncoming({ id: info.id, name: info.displayName, accept: info.accept, decline: info.decline }),
      onRemoteStream: (stream) => {
        if (remoteAudio.current) {
          remoteAudio.current.srcObject = stream;
          void remoteAudio.current.play().catch(() => undefined);
        }
      },
    });
    return stop;
  }, [s.client, s.presence, s.keys]);

  if (!incoming && !active) return <audio ref={remoteAudio} autoPlay playsInline hidden />;

  return (
    <div
      className="stack"
      data-testid="incoming-call"
      style={{ position: "fixed", bottom: 16, right: 16, zIndex: 50, background: "var(--surface, #1c1917)", padding: 16, borderRadius: 12, maxWidth: 320 }}
    >
      {incoming && !active && (
        <>
          <p>
            Call from <strong>{incoming.name}</strong>
          </p>
          <div className="row">
            <button
              type="button"
              className="btn primary"
              data-testid="accept-call"
              onClick={() => {
                void incoming
                  .accept()
                  .then((h) => {
                    setActive(h);
                    setIncoming(null);
                  })
                  .catch(() => setIncoming(null));
              }}
            >
              Accept
            </button>
            <button
              type="button"
              className="btn ghost"
              data-testid="decline-call"
              onClick={() => {
                incoming.decline();
                setIncoming(null);
              }}
            >
              Decline
            </button>
          </div>
        </>
      )}
      {active && (
        <button
          type="button"
          className="btn"
          onClick={() => {
            void active.hangup().then(() => setActive(null));
          }}
        >
          Hang up
        </button>
      )}
      <audio ref={remoteAudio} autoPlay playsInline />
    </div>
  );
}
