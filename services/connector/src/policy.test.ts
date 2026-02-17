import { describe, expect, it } from "vitest";
import { isCommandAllowed, policyRejectReason } from "./policy";

describe("policy", () => {
  it("allows safe commands", () => {
    expect(isCommandAllowed("SAFE", "echo hello")).toBe(true);
  });

  it("rejects dangerous safe commands", () => {
    expect(isCommandAllowed("SAFE", "npm install")).toBe(false);
    expect(policyRejectReason("SAFE", "npm install")).toContain("SAFE policy");
  });

  it("allows dev tools for DEV", () => {
    expect(isCommandAllowed("DEV", "npm test")).toBe(true);
  });

  it("allows everything for FULL", () => {
    expect(isCommandAllowed("FULL", "rm -rf /tmp")).toBe(true);
  });
});
