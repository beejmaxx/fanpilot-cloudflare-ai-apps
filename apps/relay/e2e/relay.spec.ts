import AxeBuilder from "@axe-core/playwright";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

test.describe("Launch Relay", () => {
  test("turns confirmed release facts into three durable posts", async ({ page }) => {
    await createThroughUI(page);
    await expect(page.getByText("Confirm what actually shipped")).toBeVisible();
    await expect(page.locator(".fact")).toHaveCount(4, { timeout: 20_000 });
    await page.getByLabel("Availability").fill("Available today to anyone with an invitation");
    for (let confirmed = 1; confirmed <= 4; confirmed += 1) {
      const button = page.locator(".fact:not(.confirmed)").first().getByRole("button", { name: "Confirm fact", exact: true });
      await expect(button).toBeEnabled(); await button.click(); await expect(page.locator(".fact.confirmed")).toHaveCount(confirmed);
    }
    await page.getByRole("button", { name: "Generate three posts" }).click();
    await expect(page.locator("article.post")).toHaveCount(3, { timeout: 25_000 });
    await expect(page.getByText("Review every post before it goes out")).toBeVisible();
    await page.reload();
    await expect(page.locator("article.post")).toHaveCount(3);
  });

  test("fact changes invalidate dependent approval and preserve human work", async ({ page, request }) => {
    const saved = await createAndGenerate(page);
    let snapshot = await getSnapshot(request, saved);
    const post = snapshot.posts[0];
    const approval = await request.post(`/api/workspaces/${saved.id}/posts/${post.id}/approve`, { headers: auth(saved) });
    expect(approval.status()).toBe(200);
    const fact = snapshot.facts.find((item: any) => post.dependencyIds.includes(item.id));
    const changed = await request.patch(`/api/workspaces/${saved.id}/facts/${fact.id}`, { headers: auth(saved), data: { value: `${fact.value} Available to invited teams.`, confirmed: true, expectedRevision: fact.revision } });
    expect(changed.status()).toBe(200);
    snapshot = await changed.json();
    expect(snapshot.posts.find((item: any) => item.id === post.id).editorialState).toBe("needs_changes");
    expect(snapshot.posts.find((item: any) => item.id === post.id).body).toBe(post.body);
  });

  test("private return links restore identity while bare IDs grant no access", async ({ browser, page }) => {
    await createThroughUI(page);
    const saved = await credentials(page);
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.getByRole("button", { name: "Share" }).click();
    await page.locator(".modal label").filter({ hasText: "My private return link" }).locator("button").click();
    const link = await page.evaluate(() => navigator.clipboard.readText());
    expect(link).toContain("#access=");
    const fresh = await browser.newContext(); const freshPage = await fresh.newPage();
    await freshPage.goto(link); await expect(freshPage.getByText("Campaign brief")).toBeVisible();
    const bare = await browser.newContext(); const barePage = await bare.newPage();
    await barePage.goto(`/launch/${saved.id}`); await expect(barePage.getByRole("heading", { name: "Private link required" })).toBeVisible();
    await fresh.close(); await bare.close();
  });

  test("one-time viewer invitations create a distinct read-only identity", async ({ browser, page, request }) => {
    await createThroughUI(page); const owner = await credentials(page);
    const inviteResponse = await request.post(`/api/workspaces/${owner.id}/invitations`, { headers: auth(owner), data: { role: "viewer" } });
    const { invitationUrl } = await inviteResponse.json();
    const guestContext = await browser.newContext(); const guest = await guestContext.newPage();
    await guest.goto(invitationUrl); await guest.getByLabel("Your name").fill("Alex"); await guest.getByRole("button", { name: "Join launch" }).click();
    await expect(guest.getByText("Campaign brief")).toBeVisible();
    const viewer = await credentials(guest); const snap = await getSnapshot(request, viewer);
    const response = await request.patch(`/api/workspaces/${viewer.id}/facts/${snap.facts[0].id}`, { headers: auth(viewer), data: { value: "Forbidden", confirmed: true, expectedRevision: snap.facts[0].revision } });
    expect(response.status()).toBe(403);
    const replay = await browser.newContext(); const replayPage = await replay.newPage(); await replayPage.goto(invitationUrl); await expect(replayPage.getByRole("alert")).toContainText(/invalid|used/i);
    await guestContext.close(); await replay.close();
  });

  test("Enter submits clarification chat and Shift+Enter keeps a newline", async ({ page }) => {
    await createThroughUI(page); await expect(page.locator(".fact")).toHaveCount(4, { timeout: 20_000 });
    const chat = page.getByLabel("Ask Launch Relay"); await chat.fill("Is this available"); await chat.press("Shift+Enter"); await chat.type("to everyone?");
    await expect(chat).toHaveValue("Is this available\nto everyone?"); await chat.press("Enter");
    await expect(page.locator(".messages .user")).toContainText("Is this available");
    await expect(page.locator(".messages .assistant")).toBeVisible();
  });

  test("main screens have no serious accessibility violations", async ({ page }) => {
    await page.goto("/"); await expect(page.getByRole("button", { name: "Create launch" })).toBeVisible();
    expect((await new AxeBuilder({ page }).analyze()).violations.filter((v) => ["serious", "critical"].includes(v.impact || ""))).toEqual([]);
    await createThroughUI(page); await expect(page.locator(".fact")).toHaveCount(4, { timeout: 20_000 });
    expect((await new AxeBuilder({ page }).analyze()).violations.filter((v) => ["serious", "critical"].includes(v.impact || ""))).toEqual([]);
  });
});

async function createThroughUI(page: Page) {
  await page.goto("/"); await page.getByRole("button", { name: "Load a real example" }).click(); await page.getByLabel("Your name").fill("Alex");
  const create = page.getByRole("button", { name: "Create launch" }); await expect(create).toBeEnabled({ timeout: 15_000 }); await create.click();
  await expect(page).toHaveURL(/\/launch\/[0-9a-f-]{36}$/);
}

async function createAndGenerate(page: Page) {
  await createThroughUI(page); await expect(page.locator(".fact")).toHaveCount(4, { timeout: 20_000 }); const saved = await credentials(page);
  const request = page.request; let snap = await getSnapshot(request, saved);
  for (const fact of snap.facts) {
    const response = await request.patch(`/api/workspaces/${saved.id}/facts/${fact.id}`, { headers: auth(saved), data: { value: fact.label === "Availability" ? "Available today to anyone with an invitation" : fact.value, confirmed: true, expectedRevision: fact.revision } }); expect(response.status()).toBe(200);
  }
  const generated = await request.post(`/api/workspaces/${saved.id}/generate`, { headers: auth(saved) }); expect(generated.status()).toBe(202);
  await expect.poll(async () => (await getSnapshot(request, saved)).posts.length, { timeout: 25_000 }).toBe(3);
  return saved;
}

async function credentials(page: Page): Promise<{ id: string; token: string }> { return page.evaluate(() => { const item = JSON.parse(localStorage.getItem("relay:recent-workspaces") || "[]")[0]; return { id: item.id, token: item.token }; }); }
const auth = (saved: { token: string }) => ({ authorization: `Bearer ${saved.token}` });
async function getSnapshot(request: APIRequestContext, saved: { id: string; token: string }): Promise<any> { const response = await request.get(`/api/workspaces/${saved.id}/snapshot`, { headers: auth(saved) }); expect(response.status()).toBe(200); return response.json(); }
