import { describe, expect, it } from "vitest";
import { PatternPolicyEngine } from "../../packages/policy/src/index.js";

describe("command pattern policy", () => {
  it("refines safe shell authorization by explicit command patterns", () => {
    const policy = new PatternPolicyEngine({ shell: "deny" }, [{ permission: "shell", target: "pnpm test*", decision: "allow" }, { permission: "shell", target: "npm test", decision: "ask" }]);
    expect(policy.decide({ permission: "shell", target: "pnpm test --runInBand", risk: "safe" })).toBe("allow");
    expect(policy.decide({ permission: "shell", target: "npm test", risk: "safe" })).toBe("ask");
    expect(policy.decide({ permission: "shell", target: "pnpm install", risk: "safe" })).toBe("deny");
    expect(policy.decide({ permission: "shell", target: "rm -rf x", risk: "destructive" })).toBe("ask");
  });
});
