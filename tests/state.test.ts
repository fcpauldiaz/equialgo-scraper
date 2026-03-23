import { shouldProcess, type PortfolioScrapeState } from "../src/state";

function baseScrapeState(overrides: Partial<PortfolioScrapeState> = {}): PortfolioScrapeState {
  return {
    lastProcessedDate: null,
    lastProcessedSystemtraderSlug: null,
    ...overrides,
  };
}

describe("shouldProcess", () => {
  it("returns true when no prior date", () => {
    expect(shouldProcess("2025-03-22", baseScrapeState(), "gemini")).toBe(true);
  });

  it("returns true when date changed", () => {
    expect(
      shouldProcess(
        "2025-03-23",
        baseScrapeState({
          lastProcessedDate: "2025-03-22",
          lastProcessedSystemtraderSlug: "gemini",
        }),
        "gemini"
      )
    ).toBe(true);
  });

  it("returns false when same date and same slug", () => {
    expect(
      shouldProcess(
        "2025-03-22",
        baseScrapeState({
          lastProcessedDate: "2025-03-22",
          lastProcessedSystemtraderSlug: "gemini",
        }),
        "gemini"
      )
    ).toBe(false);
  });

  it("returns true when same date but strategy slug changed", () => {
    expect(
      shouldProcess(
        "2025-03-22",
        baseScrapeState({
          lastProcessedDate: "2025-03-22",
          lastProcessedSystemtraderSlug: "gemini",
        }),
        "scorpio"
      )
    ).toBe(true);
  });
});
