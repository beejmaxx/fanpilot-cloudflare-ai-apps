import { describe, expect, it } from "vitest";
import { titleFromPrompt } from "../shared/title";

describe("room titles", () => {
  it("turns an event request into a short room title", () => {
    expect(titleFromPrompt("Plan a birthday dinner in Shanghai next Saturday for six people, around ¥300 each."))
      .toBe("Birthday dinner in Shanghai next Saturday");
  });

  it("caps long titles", () => {
    expect(titleFromPrompt(`Plan a ${"very ".repeat(30)}long event`)).toHaveLength(62);
  });
});
