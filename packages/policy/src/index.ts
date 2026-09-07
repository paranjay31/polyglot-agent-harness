import type { CommandRisk } from "../../shared/src/index.js";
export type Permission = "read" | "write" | "edit" | "shell" | "git" | "network" | "mcp" | "external-directory" | "subagent";
export type PolicyDecision = "allow" | "ask" | "deny";
export interface PolicyRequest { permission: Permission; target?: string; risk?: CommandRisk }
export interface PolicyEngine { decide(request: PolicyRequest): PolicyDecision }
export class RulePolicyEngine implements PolicyEngine {
  constructor(private readonly defaults: Partial<Record<Permission, PolicyDecision>> = {}) {}
  decide({ permission, risk }: PolicyRequest): PolicyDecision { if (risk === "potentially_destructive" || risk === "destructive" || risk === "privileged" || risk === "network") return "ask"; return this.defaults[permission] ?? "allow"; }
}
export interface PolicyPatternRule { permission?: Permission; target: string; decision: PolicyDecision }
/** Pattern rules refine safe action UX; destructive-risk classification always remains approval-gated. */
export class PatternPolicyEngine extends RulePolicyEngine {
  constructor(defaults: Partial<Record<Permission, PolicyDecision>> = {}, private readonly rules: PolicyPatternRule[] = []) { super(defaults); }
  decide(request: PolicyRequest): PolicyDecision { const baseline = super.decide(request); if (request.risk === "potentially_destructive" || request.risk === "destructive" || request.risk === "privileged" || request.risk === "network") return baseline; const rule = this.rules.find(candidate => (!candidate.permission || candidate.permission === request.permission) && new RegExp(`^${candidate.target.split("*").map(part => part.replace(/[|\\{}()[\]^$+?.]/g, "\\$&")).join(".*")}$`).test(request.target ?? "")); return rule?.decision ?? baseline; }
}
