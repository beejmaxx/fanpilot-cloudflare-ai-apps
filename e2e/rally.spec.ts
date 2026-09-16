import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import type { RoomSnapshot, Session } from "../src/shared/types";
import {
  auth,
  createInvitation,
  createRoom,
  generateAndWait,
  joinRoom,
  sendMessage,
  snapshot,
  waitForSocketSnapshot,
} from "./helpers";

test("two people can plan, vote, finalize, and reload the result", async ({ browser }) => {
  test.setTimeout(75_000);
  const organizerContext = await browser.newContext();
  const participantContext = await browser.newContext();
  const organizer = await organizerContext.newPage();
  const participant = await participantContext.newPage();
  const consoleErrors: string[] = [];
  organizer.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  participant.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });

  await organizer.goto("/");
  await organizer.getByLabel("Describe the plan").fill(
    "Plan a birthday dinner in Shanghai next Saturday for six people under ¥300 each.",
  );
  await organizer.getByLabel("Your name").fill("Alice");
  await organizer.getByRole("button", { name: "Create planning room" }).click();
  await expect(organizer).toHaveURL(/\/room\/[0-9a-f-]+#access=[0-9a-f]{64}$/);
  await expect(organizer.getByText("Live", { exact: true })).toBeVisible({ timeout: 20_000 });

  const roomId = new URL(organizer.url()).pathname.split("/").pop()!;
  const organizerSession = await organizer.evaluate((key) => JSON.parse(localStorage.getItem(key)!) as Session, `rally:session:${roomId}`);
  const invitationResponse = await organizer.request.post(`/api/rooms/${roomId}/invitations`, {
    headers: auth(organizerSession),
    data: {},
  });
  expect(invitationResponse.status()).toBe(200);
  const invitation = await invitationResponse.json() as { invitationUrl: string };
  await participant.goto(invitation.invitationUrl);
  await expect(participant.getByRole("heading", { name: /Birthday dinner/ })).toBeVisible();
  await participant.getByLabel("Your name").fill("Bob");
  await participant.getByRole("button", { name: "Join planning room" }).click();
  await expect(participant).toHaveURL(/\/room\/[0-9a-f-]+#access=[0-9a-f]{64}$/);
  await expect(participant.getByText("Live", { exact: true })).toBeVisible({ timeout: 20_000 });
  await expect(organizer.getByLabel("2 participants")).toBeVisible();

  await participant.getByLabel("Message the group").fill(
    "I can only make it after 7:30 PM and need a vegetarian main. Quiet would be nice.",
  );
  await participant.getByRole("button", { name: "Send message" }).click();
  await expect(organizer.getByText(/only make it after 7:30 PM/)).toBeVisible();
  await expect(organizer.getByText("vegetarian", { exact: true })).toBeVisible();

  await organizer.getByRole("button", { name: "Create three options" }).click();
  await expect(organizer.getByRole("heading", { name: "Three ways this could work" })).toBeVisible({ timeout: 20_000 });
  await expect(participant.getByRole("heading", { name: "Three ways this could work" })).toBeVisible();

  const organizerOptions = organizer.locator(".proposal-card");
  const participantOptions = participant.locator(".proposal-card");
  await organizerOptions.nth(0).getByRole("button", { name: "Vote" }).click();
  await participantOptions.nth(1).getByRole("button", { name: "Vote" }).click();
  await organizerOptions.nth(0).getByRole("button", { name: "Finalize" }).click();

  await expect(organizer.getByText("It's settled")).toBeVisible();
  await expect(participant.getByText("It's settled")).toBeVisible();
  await participant.reload();
  await expect(participant.getByText("It's settled")).toBeVisible();

  const accessibility = await new AxeBuilder({ page: organizer }).analyze();
  expect(accessibility.violations.filter((item) => item.impact === "critical" || item.impact === "serious")).toEqual([]);
  expect(consoleErrors).toEqual([]);

  await organizerContext.close();
  await participantContext.close();
});

test("room sessions enforce authentication, invitations, and organizer permissions", async ({ request }) => {
  const organizer = await createRoom(request);
  const participant = await joinRoom(request, organizer);
  expect(organizer.snapshot.aiUsage.extraction).toBe("fallback");

  expect((await request.get(`/api/rooms/${organizer.roomId}/snapshot`)).status()).toBe(401);
  expect((await request.get(`/api/rooms/${organizer.roomId}/snapshot`, {
    headers: { authorization: "Bearer invalid-token" },
  })).status()).toBe(401);
  expect((await request.post(`/api/rooms/${organizer.roomId}/join`, {
    data: { displayName: "Uninvited" },
  })).status()).toBe(404);
  expect((await request.post(`/api/rooms/${organizer.roomId}/generate`, {
    headers: auth(participant),
    data: {},
  })).status()).toBe(403);
  expect((await request.post(`/api/rooms/${organizer.roomId}/invitations`, {
    headers: auth(participant),
    data: {},
  })).status()).toBe(403);
});

test("a private return link restores exactly one identity in a fresh browser", async ({ browser, request }) => {
  const organizer = await createRoom(request, "Alex");
  const invitation = await createInvitation(request, organizer);
  const participantContext = await browser.newContext();
  const page = await participantContext.newPage();
  const requestUrls: string[] = [];
  page.on("request", (browserRequest) => requestUrls.push(browserRequest.url()));

  await page.goto(invitation.url);
  await page.getByLabel("Your name").fill("Alex");
  await page.getByRole("button", { name: "Join planning room" }).click();
  await expect(page.getByText("Live", { exact: true })).toBeVisible({ timeout: 20_000 });
  const privateUrl = page.url();
  const accessToken = new URLSearchParams(new URL(privateUrl).hash.slice(1)).get("access")!;
  expect(accessToken).toHaveLength(64);
  expect(requestUrls.some((url) => url.includes(accessToken) || url.includes(invitation.token))).toBe(false);
  await participantContext.close();

  const freshContext = await browser.newContext();
  const restored = await freshContext.newPage();
  await restored.goto(privateUrl);
  await expect(restored.getByText("Live", { exact: true })).toBeVisible({ timeout: 20_000 });
  await expect(restored.getByLabel("2 participants")).toBeVisible();
  await freshContext.close();
});

test("same display names create distinct participants and names remain editable", async ({ request }) => {
  const organizer = await createRoom(request, "Alex Kim");
  const first = await joinRoom(request, organizer, "Alex Kim");
  const second = await joinRoom(request, organizer, "Alex Kim");
  let current = await snapshot(request, organizer);
  const alexes = current.participants.filter((item) => item.displayName === "Alex Kim");
  expect(alexes).toHaveLength(3);
  expect(new Set(alexes.map((item) => item.id)).size).toBe(3);

  const renamed = await request.patch(`/api/rooms/${organizer.roomId}/participant`, {
    headers: auth(first),
    data: { displayName: "Alex One" },
  });
  expect(renamed.status()).toBe(200);
  current = await renamed.json() as RoomSnapshot;
  expect(current.participants.find((item) => item.id === first.participantId)?.displayName).toBe("Alex One");
  expect(current.participants.find((item) => item.id === second.participantId)?.displayName).toBe("Alex Kim");
});

test("return links rotate and invitation links can be reset", async ({ request }) => {
  const organizer = await createRoom(request);
  const oldInvitation = await createInvitation(request, organizer);
  const rotate = await request.post(`/api/rooms/${organizer.roomId}/participant/rotate-access`, {
    headers: auth(organizer),
    data: {},
  });
  expect(rotate.status()).toBe(200);
  const rotated = await rotate.json() as typeof organizer;
  expect(rotated.token).not.toBe(organizer.token);
  expect((await request.get(`/api/rooms/${organizer.roomId}/snapshot`, { headers: auth(organizer) })).status()).toBe(401);
  expect((await request.get(`/api/rooms/${organizer.roomId}/snapshot`, { headers: auth(rotated) })).status()).toBe(200);

  const reset = await request.post(`/api/rooms/${organizer.roomId}/invitations/reset`, {
    headers: auth(rotated),
    data: {},
  });
  expect(reset.status()).toBe(200);
  const newUrl = new URL((await reset.json() as { invitationUrl: string }).invitationUrl);
  const newToken = new URLSearchParams(newUrl.hash.slice(1)).get("invite")!;
  expect((await request.post(`/api/rooms/${organizer.roomId}/join`, {
    data: { displayName: "Old link", invitationToken: oldInvitation.token },
  })).status()).toBe(404);
  expect((await request.post(`/api/rooms/${organizer.roomId}/join`, {
    data: { displayName: "New link", invitationToken: newToken },
  })).status()).toBe(200);
});

test("changing a vote replaces it and only the organizer can finalize", async ({ request }) => {
  const organizer = await createRoom(request);
  const participant = await joinRoom(request, organizer);
  const voting = await generateAndWait(request, organizer);
  expect(voting.aiUsage.proposals).toBe("fallback");
  const [first, second] = voting.proposals;

  let response = await request.post(`/api/rooms/${organizer.roomId}/vote`, {
    headers: auth(participant),
    data: { proposalId: first.id, value: 1, reason: "First choice" },
  });
  expect(response.status()).toBe(200);

  response = await request.post(`/api/rooms/${organizer.roomId}/vote`, {
    headers: auth(participant),
    data: { proposalId: second.id, value: 1, reason: "Changed my mind" },
  });
  expect(response.status()).toBe(200);
  const afterChange = await response.json() as RoomSnapshot;
  expect(afterChange.votes).toHaveLength(1);
  expect(afterChange.votes[0]).toMatchObject({ participantId: participant.participantId, proposalId: second.id });
  expect(afterChange.proposals.find((proposal) => proposal.id === first.id)?.votes).toBe(0);
  expect(afterChange.proposals.find((proposal) => proposal.id === second.id)?.votes).toBe(1);

  expect((await request.post(`/api/rooms/${organizer.roomId}/finalize`, {
    headers: auth(participant),
    data: { proposalId: second.id },
  })).status()).toBe(403);

  response = await request.post(`/api/rooms/${organizer.roomId}/finalize`, {
    headers: auth(organizer),
    data: { proposalId: second.id },
  });
  expect(response.status()).toBe(200);
  const finalized = await response.json() as RoomSnapshot;
  expect(finalized.room).toMatchObject({ stage: "finalized", finalizedProposalId: second.id });
});

test("room state persists across fresh clients", async ({ playwright, request }) => {
  const organizer = await createRoom(request);
  const participant = await joinRoom(request, organizer, "Priya");
  await sendMessage(request, participant, "I need a vegan option and can only meet after 8 PM.");

  const freshClient = await playwright.request.newContext({ baseURL: "http://127.0.0.1:4173" });
  const restored = await snapshot(freshClient, organizer);
  expect(restored.participants.map((item) => item.displayName)).toEqual(["Alice", "Priya"]);
  expect(restored.messages.some((item) => item.body.includes("vegan option"))).toBe(true);
  expect(restored.constraints).toEqual(expect.arrayContaining([
    expect.objectContaining({ participantName: "Priya", type: "dietary", value: "vegan" }),
  ]));
  await freshClient.dispose();
});

test("WebSocket reconnect receives current state and sync frames", async ({ request }) => {
  const organizer = await createRoom(request);
  const firstConnection = await waitForSocketSnapshot(organizer.roomId, organizer.token);
  expect(firstConnection.socket.protocol).toBe("rally");
  const firstSequence = firstConnection.snapshot.eventSequence;
  firstConnection.socket.close(1000, "test reconnect");

  await sendMessage(request, organizer, "A quiet location would be nice.");
  const secondConnection = await waitForSocketSnapshot(organizer.roomId, organizer.token);
  expect(secondConnection.snapshot.eventSequence).toBeGreaterThan(firstSequence);
  expect(secondConnection.snapshot.messages.some((item) => item.body.includes("quiet location"))).toBe(true);

  const synced = new Promise<RoomSnapshot>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timed out waiting for sync frame")), 10_000);
    secondConnection.socket.addEventListener("message", (event) => {
      const payload = JSON.parse(String(event.data)) as { type: string; snapshot?: RoomSnapshot };
      if (payload.type === "snapshot" && payload.snapshot) {
        clearTimeout(timer);
        resolve(payload.snapshot);
      }
    }, { once: true });
  });
  secondConnection.socket.send("sync");
  expect((await synced).eventSequence).toBe(secondConnection.snapshot.eventSequence);
  secondConnection.socket.close(1000, "test complete");
});

test("concurrent messages are preserved and duplicate client IDs are idempotent", async ({ request }) => {
  const organizer = await createRoom(request);
  const participant = await joinRoom(request, organizer);
  const duplicateId = crypto.randomUUID();

  let response = await request.post(`/api/rooms/${organizer.roomId}/message`, {
    headers: auth(participant),
    data: { body: "Keep this message once", clientId: duplicateId },
  });
  expect(response.status()).toBe(200);
  response = await request.post(`/api/rooms/${organizer.roomId}/message`, {
    headers: auth(participant),
    data: { body: "This duplicate must be ignored", clientId: duplicateId },
  });
  expect(response.status()).toBe(200);

  const messages = Array.from({ length: 6 }, (_, index) => `Concurrent preference ${index + 1}`);
  const responses = await Promise.all(messages.map((body, index) => request.post(
    `/api/rooms/${organizer.roomId}/message`,
    {
      headers: auth(index % 2 === 0 ? organizer : participant),
      data: { body, clientId: crypto.randomUUID() },
    },
  )));
  expect(responses.every((item) => item.status() === 200)).toBe(true);

  const current = await snapshot(request, organizer);
  const userMessages = current.messages.filter((item) => item.kind === "user").map((item) => item.body);
  expect(userMessages.filter((body) => body === "Keep this message once")).toHaveLength(1);
  expect(userMessages).not.toContain("This duplicate must be ignored");
  for (const body of messages) expect(userMessages.filter((item) => item === body)).toHaveLength(1);
});

test("regeneration clears the prior result and votes before creating a fresh set", async ({ request }) => {
  const organizer = await createRoom(request);
  const participant = await joinRoom(request, organizer);
  const firstSet = await generateAndWait(request, organizer);
  const selected = firstSet.proposals[0];

  expect((await request.post(`/api/rooms/${organizer.roomId}/vote`, {
    headers: auth(participant),
    data: { proposalId: selected.id, value: 1, reason: "Works for me" },
  })).status()).toBe(200);
  expect((await request.post(`/api/rooms/${organizer.roomId}/finalize`, {
    headers: auth(organizer),
    data: { proposalId: selected.id },
  })).status()).toBe(200);

  const response = await request.post(`/api/rooms/${organizer.roomId}/generate`, {
    headers: auth(organizer),
    data: {},
  });
  expect(response.status()).toBe(202);
  const regenerating = (await response.json() as { snapshot: RoomSnapshot }).snapshot;
  expect(regenerating.room).toMatchObject({ stage: "generating", finalizedProposalId: null });
  expect(regenerating.proposals).toEqual([]);
  expect(regenerating.votes).toEqual([]);

  await expect.poll(async () => (await snapshot(request, organizer)).room.stage, {
    timeout: 20_000,
  }).toBe("voting");
  const secondSet = await snapshot(request, organizer);
  expect(secondSet.proposals).toHaveLength(3);
  expect(secondSet.proposals.map((item) => item.id)).not.toContain(selected.id);
});

test("invalid input, unknown rooms, and cross-room tokens are rejected", async ({ request }) => {
  let response = await request.post("/api/rooms", {
    headers: { "content-type": "application/json" },
    data: "{",
  });
  expect(response.status()).toBe(400);

  response = await request.get("/api/rooms/not-a-room/snapshot");
  expect(response.status()).toBe(400);
  response = await request.get("/api/rooms/00000000-0000-4000-8000-000000000000/snapshot", {
    headers: { authorization: "Bearer unknown" },
  });
  expect(response.status()).toBe(401);

  const firstRoom = await createRoom(request);
  const secondRoom = await createRoom(request, "Morgan");
  response = await request.get(`/api/rooms/${secondRoom.roomId}/snapshot`, {
    headers: auth(firstRoom),
  });
  expect(response.status()).toBe(401);

  response = await request.post(`/api/rooms/${firstRoom.roomId}/join`, {
    data: { displayName: "   " },
  });
  expect(response.status()).toBe(400);
  response = await request.post(`/api/rooms/${firstRoom.roomId}/message`, {
    headers: auth(firstRoom),
    data: { body: "x".repeat(2_001), clientId: crypto.randomUUID() },
  });
  expect(response.status()).toBe(400);
  response = await request.post(`/api/rooms/${firstRoom.roomId}/vote`, {
    headers: auth(firstRoom),
    data: { proposalId: crypto.randomUUID(), value: 1, reason: "Too early" },
  });
  expect(response.status()).toBe(409);
});

test("mobile layout remains usable through offline reconnect", async ({ browser, request }) => {
  const organizer = await createRoom(request, "Mobile Alice");
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
  });
  await context.addInitScript(({ key, value }) => {
    localStorage.setItem(key, value);
    const NativeWebSocket = window.WebSocket;
    const trackedWindow = window as typeof window & { __rallySocket?: WebSocket };
    class TrackedWebSocket extends NativeWebSocket {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        if (String(url).includes("/api/rooms/")) trackedWindow.__rallySocket = this;
      }
    }
    window.WebSocket = TrackedWebSocket;
  }, {
    key: `rally:session:${organizer.roomId}`,
    value: JSON.stringify({
      roomId: organizer.roomId,
      participantId: organizer.participantId,
      token: organizer.token,
      role: organizer.role,
    }),
  });
  const page = await context.newPage();
  await page.goto(`/room/${organizer.roomId}`);
  const connection = page.locator(".connection");
  await expect(connection).toHaveClass(/live/, { timeout: 20_000 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

  await page.getByLabel("Message the group").fill("Mobile keyboard message");
  await page.getByLabel("Message the group").press("Enter");
  await expect(page.getByText("Mobile keyboard message", { exact: true })).toBeVisible();

  await context.setOffline(true);
  await page.evaluate(() => {
    (window as typeof window & { __rallySocket?: WebSocket }).__rallySocket?.close(4000, "offline test");
  });
  await expect(connection).toHaveClass(/offline/);
  await context.setOffline(false);
  await expect(connection).toHaveClass(/live/, { timeout: 15_000 });

  const accessibility = await new AxeBuilder({ page }).analyze();
  expect(accessibility.violations.filter((item) => item.impact === "critical" || item.impact === "serious")).toEqual([]);
  await context.close();
});
