export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type CommandRisk = "safe" | "potentially_destructive" | "destructive" | "network" | "privileged";
export interface Command { argv: string[]; cwd?: string; timeoutMs?: number; risk?: CommandRisk; signal?: AbortSignal; verificationSnapshot?: Record<string, string | null> }
export interface Repository { root: string; name?: string }
export interface DetectionResult { detected: boolean; confidence: number; evidence: string[] }
export interface Symbol { name: string; kind: string; file: string; line: number; endLine?: number; exported?: boolean }
export interface Reference { file: string; line: number; target: string }
export interface Diagnostic { file: string; line?: number; severity: "error" | "warning" | "info"; message: string }
export interface Task { id: string; prompt: string; workspace: string }
export interface ExecutionResult { exitCode: number; stdout: string; stderr: string; durationMs: number }

export class ExecutionUnconfirmedError extends Error { readonly code = "EXECUTION_UNCONFIRMED"; constructor(message: string) { super(message); this.name = "ExecutionUnconfirmedError"; } }
