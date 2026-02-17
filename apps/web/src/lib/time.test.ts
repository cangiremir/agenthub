import { describe, expect, it } from "vitest";
import { statusFromLastSeen } from "./time";

describe("statusFromLastSeen", () => {
  it("returns offline for null", () => {
    expect(statusFromLastSeen(null)).toBe("offline");
  });
});
