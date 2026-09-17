import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

test.describe("Draft collaborative editor", () => {
  test("requires browser verification before allocating a document", async ({ request }) => {
    const response = await request.post("/api/documents", {
      data: { title: "Unverified", displayName: "Robot", template: "blank" },
    });
    expect(response.status()).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "Request body is invalid" });
  });

  test("rate limits repeated verified document creation", async ({ request }) => {
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 11; attempt += 1) {
      const response = await request.post("/api/documents", {
        headers: { "CF-Connecting-IP": "203.0.113.99" },
        data: {
          title: `Rate limit ${attempt}`,
          displayName: "Load test",
          template: "blank",
          turnstileToken: `test-token-${attempt}`,
        },
      });
      statuses.push(response.status());
    }
    expect(statuses.slice(0, 10)).toEqual(Array(10).fill(201));
    expect(statuses[10]).toBe(429);
  });

  test("resets browser verification and lets the user retry after rejection", async ({ page }) => {
    let rejectOnce = true;
    await page.route("**/api/documents", async (route) => {
      if (rejectOnce) {
        rejectOnce = false;
        await route.fulfill({ status: 403, contentType: "application/json", body: JSON.stringify({ error: "Browser verification failed. Please try again" }) });
        return;
      }
      await route.continue();
    });
    await page.goto("/");
    await page.getByLabel("Document title").fill("Verification retry");
    await page.getByLabel("Your name").fill("Avery");
    const create = page.getByRole("button", { name: "Create document" });
    await expect(create).toBeEnabled();
    await create.click();
    await expect(page.getByRole("alert")).toContainText("Browser verification failed");
    await expect(create).toBeEnabled({ timeout: 15_000 });
    await create.click();
    await expect(page.locator(".draft-editor")).toBeVisible({ timeout: 15_000 });
  });

  test("creates a document, strips the secret fragment, edits, and reloads", async ({ page }) => {
    await createThroughUI(page, "Launch narrative", "Avery", "Product spec");
    await expect(page).toHaveURL(/\/doc\/[0-9a-f-]{36}$/);
    await expect(page.getByRole("heading", { name: "Problem" })).toBeVisible();
    await page.getByText("What problem are we solving").click();
    await page.keyboard.press("End");
    await page.keyboard.type(" Customers lose context today.");
    await expect(page.getByText(/Customers lose context today/)).toBeVisible();
    await expect(page.getByText("Saved", { exact: true })).toBeVisible();
    await page.reload();
    await expect(page.getByText(/Customers lose context today/)).toBeVisible();
  });

  test("two same-name editors get distinct identities and converge", async ({ browser, page }) => {
    await createThroughUI(page, "Realtime spec", "Sam", "Product spec");
    const invite = await createInvite(page, "Editor");
    const second = await browser.newContext();
    const secondPage = await second.newPage();
    await joinThroughUI(secondPage, invite, "Sam");
    await expect(secondPage.locator(".avatar-stack span")).toHaveCount(2);

    const paragraph = secondPage.getByText("What problem are we solving");
    await paragraph.click();
    await secondPage.keyboard.press("End");
    await secondPage.keyboard.type(" Shared edit.");
    await expect(page.getByText(/Shared edit/)).toBeVisible();
    await expect(secondPage.getByText("Saved", { exact: true })).toBeVisible();
    await second.close();
  });

  test("invitation links are single use", async ({ browser, page }) => {
    await createThroughUI(page, "One-time invitation", "Owner", "Blank");
    const invite = await createInvite(page, "Editor");
    const first = await browser.newContext();
    const firstPage = await first.newPage();
    await joinThroughUI(firstPage, invite, "First guest");

    const second = await browser.newContext();
    const secondPage = await second.newPage();
    await secondPage.goto(invite);
    await expect(secondPage.getByRole("alert")).toContainText(/already used|invalid/i);
    await expect(secondPage.getByRole("button", { name: "Join document" })).toBeDisabled();

    await first.close();
    await second.close();
  });

  test("comments synchronize and can be resolved", async ({ browser, page }) => {
    await createThroughUI(page, "Comment review", "Owner", "Proposal");
    const invite = await createInvite(page, "Editor");
    const second = await browser.newContext();
    const reviewer = await second.newPage();
    await joinThroughUI(reviewer, invite, "Reviewer");

    await page.getByText("State the proposal and why it matters.").click();
    await page.getByLabel("Formatting toolbar").getByRole("button", { name: "Comment" }).click();
    await page.getByPlaceholder("Add a comment…").fill("Who owns the next step?");
    await page.getByRole("complementary").getByRole("button", { name: "Comment", exact: true }).click();
    await reviewer.getByRole("button", { name: "Share", exact: true }).click();
    await reviewer.getByTitle("Comments").click();
    await expect(reviewer.getByText("Who owns the next step?")).toBeVisible();
    await reviewer.getByRole("button", { name: "Resolve" }).click();
    await expect(reviewer.getByRole("button", { name: "Reopen" })).toBeVisible();
    await second.close();
  });

  test("AI proposes a diff and acceptance persists", async ({ page }) => {
    await createThroughUI(page, "AI review", "Writer", "Proposal");
    await page.getByText("State the proposal and why it matters.").click();
    await page.getByRole("button", { name: "Ask AI", exact: true }).first().click();
    const prompt = page.getByPlaceholder("Ask for a rewrite or feedback…");
    await prompt.fill("Rewrite this");
    await prompt.press("Shift+Enter");
    await prompt.type("to be clearer");
    await expect(prompt).toHaveValue("Rewrite this\nto be clearer");
    await prompt.press("Enter");
    await expect(page.getByText("PROPOSED")).toBeVisible({ timeout: 25_000 });
    const accept = page.getByRole("button", { name: "Accept" });
    await expect(accept).toBeInViewport();
    await accept.click();
    await expect(page.getByText("accepted", { exact: true })).toBeVisible();
    await page.reload();
    await page.getByRole("button", { name: "Ask AI", exact: true }).first().click();
    await page.getByTitle("History").click();
    await expect(page.getByText("Before AI edit")).toBeVisible();
    await page.getByRole("button", { name: "Revert" }).click();
    await expect(page.getByLabel("Shared document editor").getByText("State the proposal and why it matters.")).toBeVisible();
  });

  test("accept all applies one validated AI set", async ({ page }) => {
    await createThroughUI(page, "Full review", "Writer", "Proposal");
    await page.getByRole("button", { name: "Ask AI", exact: true }).first().click();
    await page.getByPlaceholder("Ask for a rewrite or feedback…").fill("Make the document clearer");
    await page.getByLabel("Send AI request").click();
    const acceptAll = page.getByRole("button", { name: /Accept all \d+ changes/ });
    await expect(acceptAll).toBeVisible({ timeout: 25_000 });
    await acceptAll.click();
    await expect(page.getByText("pending", { exact: true })).toHaveCount(0);
    await expect(page.getByLabel("Shared document editor").getByText("Clearly state the proposal and why it matters.")).toBeVisible();
  });

  test("a stale AI suggestion refuses to overwrite a human edit", async ({ page }) => {
    await createThroughUI(page, "Conflict check", "Writer", "Proposal");
    const target = page.getByLabel("Shared document editor").getByText("State the proposal and why it matters.");
    await target.click();
    await page.getByRole("button", { name: "Ask AI", exact: true }).first().click();
    await page.getByPlaceholder("Ask for a rewrite or feedback…").fill("Make this clearer");
    await page.getByLabel("Send AI request").click();
    await expect(page.getByText("PROPOSED")).toBeVisible({ timeout: 25_000 });
    await target.click();
    await page.keyboard.press("End");
    await page.keyboard.type(" Human update.");
    await expect(page.getByText("Saved", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Accept" }).click();
    await expect(page.getByRole("alert")).toContainText("changed");
    await expect(page.getByText(/Human update/)).toBeVisible();
  });

  test("concurrent acceptance persists one document update and one revision", async ({ page, request }) => {
    await createThroughUI(page, "Exactly once review", "Writer", "Proposal");
    await page.getByText("State the proposal and why it matters.").click();
    await page.getByRole("button", { name: "Ask AI", exact: true }).first().click();
    await page.getByPlaceholder("Ask for a rewrite or feedback…").fill("Make this clearer");
    await page.getByLabel("Send AI request").click();
    await expect(page.getByText("PROPOSED")).toBeVisible({ timeout: 25_000 });

    const saved = await page.evaluate(() => JSON.parse(localStorage.getItem("draft:recent-documents") ?? "[]")[0]);
    const headers = { authorization: `Bearer ${saved.token}` };
    const beforeResponse = await request.get(`/api/documents/${saved.id}/snapshot`, { headers });
    const before = await beforeResponse.json();
    const suggestionId = before.suggestions.find((item: { status: string }) => item.status === "pending").id;

    const responses = await Promise.all([
      request.post(`/api/documents/${saved.id}/suggestions/${suggestionId}/decision`, { headers, data: { decision: "accept" } }),
      request.post(`/api/documents/${saved.id}/suggestions/${suggestionId}/decision`, { headers, data: { decision: "accept" } }),
    ]);
    expect(responses.map((response) => response.status())).toEqual([200, 200]);

    const afterResponse = await request.get(`/api/documents/${saved.id}/snapshot`, { headers });
    const after = await afterResponse.json();
    expect(after.document.contentSequence).toBe(before.document.contentSequence + 1);
    expect(after.revisions).toHaveLength(1);
  });

  test("viewer links remain read only at the API and UI", async ({ browser, page, request }) => {
    await createThroughUI(page, "Read only review", "Owner", "Blank");
    const invite = await createInvite(page, "Viewer");
    const context = await browser.newContext();
    const viewer = await context.newPage();
    await joinThroughUI(viewer, invite, "Observer");
    await expect(viewer.locator("[contenteditable='false']")).toBeVisible();
    await expect(viewer.getByRole("button", { name: "Bold" })).toHaveCount(0);
    const saved = await viewer.evaluate(() => JSON.parse(localStorage.getItem("draft:recent-documents") ?? "[]")[0]);
    const response = await request.patch(`/api/documents/${saved.id}/title`, {
      headers: { authorization: `Bearer ${saved.token}` },
      data: { title: "Forbidden title" },
    });
    expect(response.status()).toBe(403);
    await context.close();
  });

  test("owner revocation disconnects an active collaborator", async ({ browser, page, request }) => {
    await createThroughUI(page, "Revocation", "Owner", "Blank");
    const invite = await createInvite(page, "Editor");
    const context = await browser.newContext();
    const collaborator = await context.newPage();
    await joinThroughUI(collaborator, invite, "Guest");
    const saved = await collaborator.evaluate(() => JSON.parse(localStorage.getItem("draft:recent-documents") ?? "[]")[0]);
    await expect(page.getByText("Guest")).toBeVisible();
    await page.locator(".people-list").getByRole("button", { name: "Revoke" }).click();
    await expect(collaborator.getByText("Access ended", { exact: true })).toBeVisible();
    const response = await request.get(`/api/documents/${saved.id}/session`, { headers: { authorization: `Bearer ${saved.token}` } });
    expect(response.status()).toBe(401);
    await context.close();
  });

  test("rotating a return link invalidates the old secret", async ({ page, request }) => {
    await createThroughUI(page, "Rotation", "Owner", "Blank");
    const before = await page.evaluate(() => JSON.parse(localStorage.getItem("draft:recent-documents") ?? "[]")[0]);
    await page.getByRole("button", { name: "Share", exact: true }).click();
    await page.getByRole("button", { name: "Rotate my private return link" }).click();
    await expect.poll(async () => page.evaluate(() => JSON.parse(localStorage.getItem("draft:recent-documents") ?? "[]")[0].token)).not.toBe(before.token);
    const after = await page.evaluate(() => JSON.parse(localStorage.getItem("draft:recent-documents") ?? "[]")[0]);
    await expect(page.locator(".draft-editor")).toBeVisible();
    const oldResponse = await request.get(`/api/documents/${before.id}/session`, { headers: { authorization: `Bearer ${before.token}` } });
    expect(oldResponse.status()).toBe(401);
  });

  test("bare document IDs do not grant access", async ({ page }) => {
    await createThroughUI(page, "Private draft", "Owner", "Blank");
    const url = page.url();
    await page.evaluate(() => localStorage.clear());
    await page.goto(url);
    await expect(page.getByRole("heading", { name: "Private link required" })).toBeVisible();
  });

  test("a copied private return link restores the same identity in a fresh browser", async ({ browser, page }) => {
    await createThroughUI(page, "Private return", "Owner", "Blank");
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.getByRole("button", { name: "Share", exact: true }).click();
    await page.getByRole("button", { name: "Copy my private return link" }).click();
    await expect(page.getByRole("button", { name: "Private return link copied" })).toBeVisible();
    const returnLink = await page.evaluate(() => navigator.clipboard.readText());
    expect(returnLink).toContain("#access=");

    const freshContext = await browser.newContext();
    const freshPage = await freshContext.newPage();
    await freshPage.goto(returnLink);
    await expect(freshPage.locator(".draft-editor")).toBeVisible({ timeout: 15_000 });
    await expect(freshPage.getByText("Owner (you)")).toHaveCount(0);
    const saved = await freshPage.evaluate(() => JSON.parse(localStorage.getItem("draft:recent-documents") ?? "[]")[0]);
    const original = await page.evaluate(() => JSON.parse(localStorage.getItem("draft:recent-documents") ?? "[]")[0]);
    expect(saved.participantId).toBe(original.participantId);
    await freshContext.close();
  });

  test("main screens have no serious accessibility violations", async ({ page }) => {
    await page.goto("/");
    let results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
    expect(results.violations.filter((violation) => ["serious", "critical"].includes(violation.impact ?? ""))).toEqual([]);
    await createThroughUI(page, "Accessible draft", "Avery", "Product spec");
    results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
    expect(results.violations.filter((violation) => ["serious", "critical"].includes(violation.impact ?? ""))).toEqual([]);
  });
});

async function createThroughUI(page: Page, title: string, name: string, template: "Blank" | "Product spec" | "Proposal") {
  await page.goto("/");
  await page.getByLabel("Document title").fill(title);
  await page.getByLabel("Your name").fill(name);
  await page.getByRole("button", { name: template, exact: true }).click();
  const create = page.getByRole("button", { name: "Create document" });
  await expect(create).toBeEnabled({ timeout: 15_000 });
  await create.click();
  await expect(page.locator(".draft-editor")).toBeVisible({ timeout: 15_000 });
}

async function createInvite(page: Page, role: "Editor" | "Viewer"): Promise<string> {
  await page.getByRole("button", { name: "Share", exact: true }).click();
  await page.getByLabel("Invite as").selectOption(role.toLowerCase());
  await page.getByRole("button", { name: "Create invite link" }).click();
  return page.locator(".copy-link input").inputValue();
}

async function joinThroughUI(page: Page, invite: string, name: string) {
  await page.goto(invite);
  await expect(page.getByText("DOCUMENT INVITATION")).toBeVisible();
  await page.getByLabel("Your name").fill(name);
  await page.getByRole("button", { name: "Join document" }).click();
  await expect(page.locator(".draft-editor")).toBeVisible({ timeout: 15_000 });
}
