import { useEffect, useRef, useState } from "react";

declare global { interface Window { turnstile?: { render(node: HTMLElement, options: Record<string, unknown>): string; reset(id: string): void; remove(id: string): void; }; } }
let scriptPromise: Promise<NonNullable<Window["turnstile"]>> | undefined;

export default function Turnstile({ resetKey, onToken }: { resetKey: number; onToken(token: string | null): void }) {
  const host = useRef<HTMLDivElement>(null); const widget = useRef<string | undefined>(undefined); const [status, setStatus] = useState("loading");
  useEffect(() => { let cancelled = false;
    Promise.all([load(), fetch("/api/turnstile").then((r) => r.json() as Promise<{ siteKey: string; action: string }>)]).then(([api, config]) => {
      if (cancelled || !host.current) return;
      widget.current = api.render(host.current, { sitekey: config.siteKey, action: config.action, theme: "light", callback: (token: string) => { setStatus("ready"); onToken(token); }, "expired-callback": () => { setStatus("loading"); onToken(null); }, "error-callback": () => { setStatus("error"); onToken(null); } });
    }).catch(() => setStatus("error"));
    return () => { cancelled = true; if (widget.current && window.turnstile) window.turnstile.remove(widget.current); };
  }, [resetKey, onToken]);
  return <div className="turnstile-wrap"><div ref={host} /><span aria-live="polite">{status === "loading" ? "Checking browser…" : status === "ready" ? "Browser check complete" : "Browser check could not load. Try refreshing."}</span></div>;
}

function load(): Promise<NonNullable<Window["turnstile"]>> {
  if (window.turnstile) return Promise.resolve(window.turnstile); if (scriptPromise) return scriptPromise;
  scriptPromise = new Promise((resolve, reject) => { const s = document.createElement("script"); s.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit"; s.async = true; s.defer = true; s.onload = () => window.turnstile ? resolve(window.turnstile) : reject(); s.onerror = reject; document.head.appendChild(s); });
  return scriptPromise;
}
