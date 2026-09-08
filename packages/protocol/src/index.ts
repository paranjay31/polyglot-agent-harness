import type { Json } from "../../shared/src/index.js";
export type AgentEventType = "agent.started" | "plan.created" | "model.requested" | "tool.requested" | "tool.approved" | "tool.denied" | "tool.executed" | "context.compacted" | "budget.exhausted" | "verification.started" | "verification.completed" | "agent.completed" | "agent.unverified" | "agent.failed" | "agent.cancelled";
export interface AgentEvent { id: string; sessionId: string; turn: number; type: AgentEventType; timestamp: string; data: Json }
export interface EventSink { append(event: AgentEvent): Promise<void> }
export class InMemoryEventSink implements EventSink { readonly events: AgentEvent[] = []; async append(event: AgentEvent) { this.events.push(event); } }
const credentialValue = /\b(?:sk-[A-Za-z0-9_-]{12,}|AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{20,}|xox(?:b|p|a)-[A-Za-z0-9-]{16,}|AIza[0-9A-Za-z_-]{20,}|(?:Bearer\s+)[A-Za-z0-9._-]{12,})\b/g;
const credentialKey = /api[_-]?key|token|password|secret|authorization|credential|cookie/i;
function redact(value: Json, key = ""): Json { if (typeof value === "string") return value.replace(credentialValue, "[REDACTED]"); if (Array.isArray(value)) return value.map(item => redact(item)); if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, credentialKey.test(name) ? "[REDACTED]" : redact(item, name)])); return key && credentialKey.test(key) ? "[REDACTED]" : value; }
/** Redacts common credential-shaped values before a sink persists or exports events. */
export class RedactingEventSink implements EventSink { constructor(private readonly sink: EventSink) {} append(event: AgentEvent) { return this.sink.append({ ...event, data: redact(event.data) }); } }
