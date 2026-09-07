export interface EvaluationScenario { id: string; language: "typescript" | "java" | "python"; framework?: "react" | "springboot" | "fastapi"; prompt: string; run(): Promise<{ passed: boolean; testPassed?: boolean; turns?: number; tokens?: number; toolCalls?: number; contextTokens?: number; failedAttempts?: number; recovered?: boolean; detail?: string }> }
export interface EvaluationResult { id: string; passed: boolean; testPassed?: boolean; durationMs: number; turns?: number; tokens?: number; toolCalls?: number; contextTokens?: number; failedAttempts?: number; recovered?: boolean; detail?: string }
export interface EvaluationSummary { scenarios: number; passed: number; testPassed: number; totalTurns: number; totalTokens: number; totalToolCalls: number; totalContextTokens: number; failedAttempts: number; recovered: number; durationMs: number }
export class EvaluationHarness { async run(scenarios: EvaluationScenario[]): Promise<EvaluationResult[]> { return Promise.all(scenarios.map(async scenario => { const started = performance.now(); const result = await scenario.run(); return { id: scenario.id, durationMs: performance.now() - started, ...result }; })); } summarize(results: EvaluationResult[]): EvaluationSummary { return results.reduce<EvaluationSummary>((summary, result) => ({ scenarios: summary.scenarios + 1, passed: summary.passed + Number(result.passed), testPassed: summary.testPassed + Number(result.testPassed ?? result.passed), totalTurns: summary.totalTurns + (result.turns ?? 0), totalTokens: summary.totalTokens + (result.tokens ?? 0), totalToolCalls: summary.totalToolCalls + (result.toolCalls ?? 0), totalContextTokens: summary.totalContextTokens + (result.contextTokens ?? 0), failedAttempts: summary.failedAttempts + (result.failedAttempts ?? 0), recovered: summary.recovered + Number(result.recovered), durationMs: summary.durationMs + result.durationMs }), { scenarios: 0, passed: 0, testPassed: 0, totalTurns: 0, totalTokens: 0, totalToolCalls: 0, totalContextTokens: 0, failedAttempts: 0, recovered: 0, durationMs: 0 }); } }
export const benchmarkCatalog = [
  { id: "react-component-change", language: "typescript", framework: "react", prompt: "Modify a React component and its test." },
  { id: "react-component-usage", language: "typescript", framework: "react", prompt: "Trace where a React component is used and make a compatible change." },
  { id: "react-api-integration", language: "typescript", framework: "react", prompt: "Add an API client integration." },
  { id: "react-failing-test", language: "typescript", framework: "react", prompt: "Diagnose and fix a failing React component test." },
  { id: "react-hook-refactor", language: "typescript", framework: "react", prompt: "Refactor a hook while preserving its consumers." },
  { id: "spring-rest-endpoint", language: "java", framework: "springboot", prompt: "Add a REST endpoint and service test." },
  { id: "spring-service-change", language: "java", framework: "springboot", prompt: "Modify a Spring service and its unit test." },
  { id: "spring-di-trace", language: "java", framework: "springboot", prompt: "Trace constructor-injected dependencies from controller to repository." },
  { id: "spring-failing-integration-test", language: "java", framework: "springboot", prompt: "Diagnose and fix a failing Spring integration test." },
  { id: "spring-config-change", language: "java", framework: "springboot", prompt: "Modify profile-aware Spring configuration." },
  { id: "fastapi-endpoint", language: "python", framework: "fastapi", prompt: "Add a FastAPI endpoint and endpoint test." },
  { id: "fastapi-pydantic-model", language: "python", framework: "fastapi", prompt: "Modify a Pydantic request/response model and tests." },
  { id: "fastapi-dependency-trace", language: "python", framework: "fastapi", prompt: "Trace a FastAPI dependency from route to service." },
  { id: "fastapi-async-fix", language: "python", framework: "fastapi", prompt: "Fix an async dependency bug." },
  { id: "fastapi-endpoint-tests", language: "python", framework: "fastapi", prompt: "Add focused tests for an existing endpoint." }
] as const;
