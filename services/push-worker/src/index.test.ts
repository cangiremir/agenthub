import { describe, expect, it } from "vitest";
import { nextAttemptAt } from "./index";

describe("push worker", () => {
  it("returns a future ISO timestamp", () => {
    const now = Date.now();
    const ts = new Date(nextAttemptAt(1)).getTime();
    expect(ts).toBeGreaterThan(now);
  });
});
