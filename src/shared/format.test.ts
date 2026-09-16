import { describe, expect, it } from "vitest";
import { initials, pluralize } from "./format";

describe("format helpers", () => {
  it("uses at most two initials", () => {
    expect(initials("Mei Lin Chen")).toBe("ML");
  });

  it("pluralizes labels", () => {
    expect(pluralize(1, "vote")).toBe("1 vote");
    expect(pluralize(3, "vote")).toBe("3 votes");
  });
});
