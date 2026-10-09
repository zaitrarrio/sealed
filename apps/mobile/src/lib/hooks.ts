import { useEffect, useRef } from "react";

/**
 * An AbortSignal that aborts only when the component really unmounts. React StrictMode runs effects
 * mount → cleanup → mount in development; the abort is deferred a tick and cancelled by the re-mount, so
 * one-shot flows (claims cannot be retried) survive it.
 */
export function useUnmountSignal(): AbortSignal {
  const ref = useRef<{ ctl: AbortController; timer: ReturnType<typeof setTimeout> | null } | null>(null);
  if (!ref.current) ref.current = { ctl: new AbortController(), timer: null };
  useEffect(() => {
    const r = ref.current!;
    if (r.timer) {
      clearTimeout(r.timer);
      r.timer = null;
    }
    return () => {
      r.timer = setTimeout(() => r.ctl.abort(), 0);
    };
  }, []);
  return ref.current.ctl.signal;
}

/** Runs `fn` on real unmount only (same StrictMode handling as useUnmountSignal). */
export function useOnUnmount(fn: () => void): void {
  const signal = useUnmountSignal();
  const fnRef = useRef(fn);
  fnRef.current = fn;
  useEffect(() => {
    const onAbort = () => fnRef.current();
    signal.addEventListener("abort", onAbort, { once: true });
    return () => signal.removeEventListener("abort", onAbort);
  }, [signal]);
}
