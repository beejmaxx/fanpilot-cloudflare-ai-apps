import assert from "node:assert/strict";

const baseUrl = process.env.RALLY_BASE_URL?.replace(/\/$/, "");
if (!baseUrl) {
  throw new Error("Set RALLY_BASE_URL to the deployed Rally origin, for example https://rally-planner.example.workers.dev");
}

async function request(path, init = {}, token) {
  const headers = new Headers(init.headers);
  if (init.body) headers.set("content-type", "application/json");
  if (token) headers.set("authorization", `Bearer ${token}`);
  const response = await fetch(`${baseUrl}${path}`, { ...init, headers });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${init.method ?? "GET"} ${path} failed (${response.status}): ${JSON.stringify(data)}`);
  return data;
}

const created = await request("/api/rooms", {
  method: "POST",
  body: JSON.stringify({
    organizerName: "Remote AI Smoke",
    prompt: "Plan a quiet vegetarian dinner in Shanghai next Saturday for six people under ¥300 each.",
  }),
});

assert.equal(created.snapshot.aiUsage.extraction, "workers-ai", "Room creation used the deterministic fallback instead of Workers AI");
assert.ok(created.snapshot.constraints.length > 0, "Workers AI did not extract any constraints");

await request(`/api/rooms/${created.roomId}/message`, {
  method: "POST",
  body: JSON.stringify({
    body: "I can only attend after 7:30 PM and need a step-free entrance.",
    clientId: crypto.randomUUID(),
  }),
}, created.token);

await request(`/api/rooms/${created.roomId}/generate`, {
  method: "POST",
  body: "{}",
}, created.token);

let snapshot;
const deadline = Date.now() + 60_000;
while (Date.now() < deadline) {
  snapshot = await request(`/api/rooms/${created.roomId}/snapshot`, {}, created.token);
  if (snapshot.room.stage === "voting") break;
  if (snapshot.room.workflowStatus === "failed") throw new Error("Proposal Workflow failed during remote AI smoke test");
  await new Promise((resolve) => setTimeout(resolve, 1_000));
}

assert.equal(snapshot?.room.stage, "voting", "Proposal Workflow did not reach voting within 60 seconds");
assert.equal(snapshot.aiUsage.proposals, "workers-ai", "Proposal generation used the deterministic fallback instead of Workers AI");
assert.equal(snapshot.proposals.length, 3, "Workers AI did not produce exactly three proposals");
for (const proposal of snapshot.proposals) {
  assert.ok(proposal.title && proposal.summary, "Proposal title or summary is empty");
  assert.ok(proposal.details.when && proposal.details.where && proposal.details.cost, "Proposal details are incomplete");
  assert.ok(Array.isArray(proposal.details.notes) && Array.isArray(proposal.tradeoffs), "Proposal arrays are malformed");
  assert.ok(proposal.score >= 0 && proposal.score <= 100, "Proposal score is outside the schema range");
}

console.log(`Remote Workers AI smoke passed for room ${created.roomId}`);
