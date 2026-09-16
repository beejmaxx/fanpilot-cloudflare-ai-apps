import assert from "node:assert/strict";

const baseUrl = process.env.RALLY_BASE_URL?.replace(/\/$/, "");
const versionId = process.env.RALLY_VERSION_ID;
if (!baseUrl) throw new Error("Set RALLY_BASE_URL to the deployed Rally origin");

async function call(path, init = {}, token, expected = 200) {
  const headers = new Headers(init.headers);
  if (init.body) headers.set("content-type", "application/json");
  if (token) headers.set("authorization", `Bearer ${token}`);
  if (versionId) headers.set("Cloudflare-Workers-Version-Overrides", `rally-planner="${versionId}"`);
  const response = await fetch(`${baseUrl}${path}`, { ...init, headers });
  const data = await response.json().catch(() => ({}));
  assert.equal(response.status, expected, `${init.method ?? "GET"} ${path}: ${JSON.stringify(data)}`);
  return data;
}

const created = await call("/api/rooms", {
  method: "POST",
  body: JSON.stringify({
    organizerName: "Same Name",
    prompt: "Plan a small link-access test meetup in Shanghai tomorrow evening.",
  }),
});
assert.match(created.token, /^[0-9a-f]{64}$/);

const invitation = await call(`/api/rooms/${created.roomId}/invitations`, {
  method: "POST",
  body: "{}",
}, created.token);
const invitationUrl = new URL(invitation.invitationUrl);
assert.equal(invitationUrl.pathname, `/join/${created.roomId}`);
const invitationToken = new URLSearchParams(invitationUrl.hash.slice(1)).get("invite");
assert.match(invitationToken, /^[0-9a-f]{64}$/);

await call(`/api/rooms/${created.roomId}/join`, {
  method: "POST",
  body: JSON.stringify({ displayName: "Uninvited" }),
}, undefined, 404);

const joined = await call(`/api/rooms/${created.roomId}/join`, {
  method: "POST",
  body: JSON.stringify({ displayName: "Same Name", invitationToken }),
});
assert.notEqual(joined.participantId, created.participantId);
assert.equal(joined.snapshot.participants.filter((item) => item.displayName === "Same Name").length, 2);

const restored = await call(`/api/rooms/${created.roomId}/session`, {}, joined.token);
assert.equal(restored.participantId, joined.participantId);
assert.equal(restored.snapshot.participants.length, 2);

const rotated = await call(`/api/rooms/${created.roomId}/participant/rotate-access`, {
  method: "POST",
  body: "{}",
}, joined.token);
assert.notEqual(rotated.token, joined.token);
await call(`/api/rooms/${created.roomId}/snapshot`, {}, joined.token, 401);
await call(`/api/rooms/${created.roomId}/snapshot`, {}, rotated.token);

const reset = await call(`/api/rooms/${created.roomId}/invitations/reset`, {
  method: "POST",
  body: "{}",
}, created.token);
const replacementToken = new URLSearchParams(new URL(reset.invitationUrl).hash.slice(1)).get("invite");
await call(`/api/rooms/${created.roomId}/join`, {
  method: "POST",
  body: JSON.stringify({ displayName: "Old invite", invitationToken }),
}, undefined, 404);
await call(`/api/rooms/${created.roomId}/join`, {
  method: "POST",
  body: JSON.stringify({ displayName: "New invite", invitationToken: replacementToken }),
});

console.log(`Remote room-link access smoke passed for room ${created.roomId}`);
