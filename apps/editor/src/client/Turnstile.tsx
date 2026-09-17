import { useEffect, useRef, useState } from "react";
import * as api from "./api";

interface TurnstileApi {
  render(container: HTMLElement, options: Record<string, unknown>): string;
  remove(widgetId: string): void;
  reset(widgetId: string): void;
}

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

let scriptPromise: Promise<TurnstileApi> | undefined;

export function Turnstile({ onToken, resetSignal }: { onToken: (token: string) => void; resetSignal: number }) {
  const container = useRef<HTMLDivElement>(null);
  const widgetId = useRef<string | undefined>(undefined);
  const callbacks = useRef({ onToken });
  const [attempt, setAttempt] = useState(0);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");

  callbacks.current.onToken = onToken;

  useEffect(() => {
    let disposed = false;
    setStatus("loading");
    Promise.all([api.turnstileConfig(), loadTurnstile()]).then(([config, turnstile]) => {
      if (disposed || !container.current) return;
      widgetId.current = turnstile.render(container.current, {
        sitekey: config.siteKey,
        action: config.action,
        appearance: "interaction-only",
        theme: "light",
        size: "flexible",
        "refresh-expired": "auto",
        callback: (token: string) => {
          callbacks.current.onToken(token);
          setStatus("ready");
        },
        "expired-callback": () => callbacks.current.onToken(""),
        "timeout-callback": () => callbacks.current.onToken(""),
        "error-callback": () => {
          callbacks.current.onToken("");
          setStatus("error");
          return true;
        },
      });
    }).catch(() => {
      if (!disposed) setStatus("error");
    });
    return () => {
      disposed = true;
      if (widgetId.current && window.turnstile) window.turnstile.remove(widgetId.current);
      widgetId.current = undefined;
    };
  }, [attempt]);

  useEffect(() => {
    if (!resetSignal || !widgetId.current || !window.turnstile) return;
    callbacks.current.onToken("");
    setStatus("loading");
    window.turnstile.reset(widgetId.current);
  }, [resetSignal]);

  return <div className="turnstile-field">
    <div ref={container} className="turnstile-widget" />
    <p className={`turnstile-status ${status}`} role="status" aria-live="polite">
      {status === "loading" && "Checking your browser…"}
      {status === "ready" && "Browser check complete"}
      {status === "error" && <>Browser check could not load. <button type="button" onClick={() => setAttempt((value) => value + 1)}>Try again</button></>}
    </p>
  </div>;
}

function loadTurnstile(): Promise<TurnstileApi> {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  if (scriptPromise) return scriptPromise;
  scriptPromise = new Promise<TurnstileApi>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
    script.async = true;
    script.defer = true;
    script.onload = () => window.turnstile ? resolve(window.turnstile) : reject(new Error("Turnstile did not initialize"));
    script.onerror = () => reject(new Error("Turnstile could not load"));
    document.head.appendChild(script);
  }).catch((error) => {
    scriptPromise = undefined;
    throw error;
  });
  return scriptPromise;
}
