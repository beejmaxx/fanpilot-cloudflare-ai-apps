import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "./env";
import { HttpError } from "./http";
import { TURNSTILE_ACTION, TURNSTILE_TEST_SITE_KEY, turnstileSiteKey, verifyTurnstile } from "./turnstile";

const productionEnv = {
  TURNSTILE_SITE_KEY: "production-site-key",
  TURNSTILE_SECRET_KEY: "production-secret-key",
  TURNSTILE_EXPECTED_HOSTNAME: "editor.fanpilot.app",
} as Env;

afterEach(() => vi.restoreAllMocks());

describe("Turnstile configuration", () => {
  it("uses the official test site key only on local hosts", () => {
    expect(turnstileSiteKey(new URL("http://127.0.0.1:4273"), productionEnv)).toBe(TURNSTILE_TEST_SITE_KEY);
    expect(turnstileSiteKey(new URL("https://editor.fanpilot.app"), productionEnv)).toBe("production-site-key");
  });

  it("fails closed when production configuration is missing", () => {
    expect(() => turnstileSiteKey(new URL("https://editor.fanpilot.app"), {} as Env)).toThrow(HttpError);
  });
});

describe("Turnstile verification", () => {
  it("sends the token, remote IP, and idempotency key and accepts the expected response", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      success: true,
      hostname: "editor.fanpilot.app",
      action: TURNSTILE_ACTION,
    }), { status: 200 }));

    await verifyTurnstile("browser-token", new Request("https://editor.fanpilot.app/api/documents", {
      headers: { "CF-Connecting-IP": "203.0.113.4" },
    }), productionEnv);

    const init = fetchMock.mock.calls[0][1];
    const body = init?.body as FormData;
    expect(body.get("secret")).toBe("production-secret-key");
    expect(body.get("response")).toBe("browser-token");
    expect(body.get("remoteip")).toBe("203.0.113.4");
    expect(body.get("idempotency_key")).toMatch(/^[0-9a-f-]{36}$/);
  });

  it.each([
    [{ success: false, "error-codes": ["invalid-input-response"] }, "rejected token"],
    [{ success: true, hostname: "attacker.example", action: TURNSTILE_ACTION }, "wrong hostname"],
    [{ success: true, hostname: "editor.fanpilot.app", action: "other-action" }, "wrong action"],
  ])("rejects a %s response", async (result, _label) => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify(result), { status: 200 }));
    await expect(verifyTurnstile("browser-token", new Request("https://editor.fanpilot.app/api/documents"), productionEnv))
      .rejects.toMatchObject({ status: 403 });
  });

  it("returns a retryable error when Siteverify is unavailable", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network down"));
    await expect(verifyTurnstile("browser-token", new Request("https://editor.fanpilot.app/api/documents"), productionEnv))
      .rejects.toMatchObject({ status: 503 });
  });

  it("fails closed without a production secret", async () => {
    await expect(verifyTurnstile("browser-token", new Request("https://editor.fanpilot.app/api/documents"), {
      TURNSTILE_SITE_KEY: "site-key",
    } as Env)).rejects.toMatchObject({ status: 503 });
  });
});
