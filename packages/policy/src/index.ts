import type { CommandRisk } from "../../shared/src/index.js";
export type Permission = "read" | "write" | "edit" | "shell" | "git" | "network" | "mcp" | "external-directory" | "subagent";
export type PolicyDecision = "allow" | "ask" | "deny";
export interface PolicyRequest { permission: Permission; target?: string; risk?: CommandRisk }
export interface PolicyEngine { decide(request: PolicyRequest): PolicyDecision }
export class RulePolicyEngine implements PolicyEngine {
  constructor(private readonly defaults: Partial<Record<Permission, PolicyDecision>> = {}) {}
  decide({ permission, risk }: PolicyRequest): PolicyDecision { if (this.defaults[permission] === "deny") return "deny"; if (risk === "potentially_destructive" || risk === "destructive" || risk === "privileged" || risk === "network") return "ask"; return this.defaults[permission] ?? "allow"; }
}
export interface PolicyPatternRule { permission?: Permission; target: string; decision: PolicyDecision }
/** Pattern rules refine safe action UX; destructive-risk classification always remains approval-gated. */
export class PatternPolicyEngine extends RulePolicyEngine {
  constructor(defaults: Partial<Record<Permission, PolicyDecision>> = {}, private readonly rules: PolicyPatternRule[] = []) { super(defaults); }
  decide(request: PolicyRequest): PolicyDecision { const baseline = super.decide(request); if (request.risk === "potentially_destructive" || request.risk === "destructive" || request.risk === "privileged" || request.risk === "network") return baseline; const rule = this.rules.find(candidate => (!candidate.permission || candidate.permission === request.permission) && new RegExp(`^${candidate.target.split("*").map(part => part.replace(/[|\\{}()[\]^$+?.]/g, "\\$&")).join(".*")}$`).test(request.target ?? "")); return rule?.decision ?? baseline; }
}

export function formatApprovalRequest(request: PolicyRequest & { tool: string; input: unknown }): string {
  // JSON escapes terminal control characters and preserves complete arguments and proposed edits.
  return `Approval required\nTool: ${JSON.stringify(request.tool)}\nPermission: ${request.permission}\nRisk: ${request.risk ?? "unspecified"}\nTarget: ${JSON.stringify(request.target ?? "")}\nAction and scope:\n${JSON.stringify(request.input, null, 2)}\nApprove this action? [y/N] `;
}
