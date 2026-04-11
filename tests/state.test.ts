import { shouldProcess } from "../src/state";

describe("shouldProcess", () => {
  it("returns true when no prior date for this slug", () => {
    expect(shouldProcess("2025-03-22", null)).toBe(true);
  });

  it("returns true when date changed", () => {
    expect(shouldProcess("2025-03-23", "2025-03-22")).toBe(true);
  });

  it("returns false when same date already processed for this slug", () => {
    expect(shouldProcess("2025-03-22", "2025-03-22")).toBe(false);
  });
});
