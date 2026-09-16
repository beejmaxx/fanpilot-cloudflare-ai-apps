import { createHash, randomBytes, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const versionId = process.env.RALLY_VERSION_ID;
if (!versionId) throw new Error("Set RALLY_VERSION_ID to an uploaded Worker version");

const baseUrl = process.env.RALLY_BASE_URL ?? "https://fanpilot.app";
const projectDir = resolve(fileURLToPath(new URL("..", import.meta.url)));
const override = `rally-planner="${versionId}"`;
const token = randomBytes(32).toString("hex");
const tokenHash = createHash("sha256").update(token).digest("hex");
const marker = randomUUID();
const email = `remote-auth-${marker}@example.com`;
const deliveryEmail = `remote-delivery-${marker}@example.com`;
const now = Date.now();

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sqlValue(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function executeRemoteSql(sql) {
  const filename = resolve(tmpdir(), `rally-auth-smoke-${randomUUID()}.sql`);
  writeFileSync(filename, sql);
  try {
    execFileSync("npx", ["wrangler", "d1", "execute", "rally-auth", "--remote", "--file", filename], {
      cwd: projectDir,
      stdio: "pipe",
      encoding: "utf8",
    });
  } finally {
    unlinkSync(filename);
  }
}

async function request(path, init = {}) {
  const headers = new Headers(init.headers);
  headers.set("Cloudflare-Workers-Version-Overrides", override);
  return fetch(`${baseUrl}${path}`, { ...init, headers, redirect: init.redirect ?? "manual" });
}

executeRemoteSql(`
  INSERT INTO auth_challenges
    (token_hash, email, display_name, intent_type, intent_json, expires_at, consumed_at, created_at)
  VALUES (
    ${sqlValue(tokenHash)}, ${sqlValue(email)}, 'Remote Auth Test', 'rooms', '{"type":"rooms"}',
    ${now + 10 * 60 * 1_000}, NULL, ${now}
  );
`);

try {
  let response = await request("/api/health");
  assert(response.status === 200, `Expected health 200, received ${response.status}`);

  response = await request(`/api/auth/verify?token=${token}`);
  assert(response.status === 302, `Expected verification 302, received ${response.status}`);
  assert(response.headers.get("location") === "/rooms", "Magic link did not preserve its rooms intent");
  const setCookie = response.headers.get("set-cookie") ?? "";
  assert(setCookie.includes("rally_account="), "Verification did not create an account cookie");
  assert(setCookie.includes("HttpOnly"), "Account cookie is missing HttpOnly");
  assert(setCookie.includes("Secure"), "Account cookie is missing Secure");
  assert(setCookie.includes("SameSite=Lax"), "Account cookie is missing SameSite=Lax");
  const cookie = setCookie.split(";", 1)[0];

  response = await request("/api/auth/me", { headers: { cookie } });
  assert(response.status === 200, `Expected account lookup 200, received ${response.status}`);
  const account = await response.json();
  assert(account.user?.email === email, "Remote D1 did not restore the verified account");

  response = await request(`/api/auth/verify?token=${token}`);
  assert(response.status === 401, `Expected replayed link 401, received ${response.status}`);

  response = await request("/api/account/rooms", { headers: { cookie } });
  assert(response.status === 200, `Expected room list 200, received ${response.status}`);
  assert(Array.isArray((await response.json()).rooms), "Room list response is malformed");

  response = await request("/api/auth/logout", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: "{}",
  });
  assert(response.status === 200, `Expected logout 200, received ${response.status}`);
  assert((response.headers.get("set-cookie") ?? "").includes("Max-Age=0"), "Logout did not clear the cookie");
  assert((await request("/api/account/rooms", { headers: { cookie } })).status === 401, "Revoked session still has access");

  response = await request("/api/auth/verify?token=invalid");
  assert(response.status === 400, `Expected malformed link 400, received ${response.status}`);

  response = await request("/api/auth/magic-link", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: deliveryEmail,
      displayName: "Remote Delivery Test",
      intent: { type: "rooms" },
    }),
  });
  assert(response.status === 200 || response.status === 503, `Unexpected email response ${response.status}`);
  const delivery = await response.json();
  assert(!("devMagicLink" in delivery), "Production response exposed a magic-link token");

  console.log(JSON.stringify({
    ok: true,
    versionId,
    checks: [
      "health",
      "remote D1 verification",
      "secure session cookie",
      "single-use token",
      "account restoration",
      "logout revocation",
      "invalid token rejection",
      "production token non-disclosure",
    ],
    emailStatus: response.status,
  }, null, 2));
} finally {
  executeRemoteSql(`
    DELETE FROM auth_challenges WHERE email IN (${sqlValue(email)}, ${sqlValue(deliveryEmail)});
    DELETE FROM users WHERE email = ${sqlValue(email)};
  `);
}
