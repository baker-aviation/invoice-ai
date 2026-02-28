export type AgentRole =
  | "code-writer"
  | "code-reviewer"
  | "security-auditor"
  | "database-agent"
  | "testing-agent";

export type ExecutionMode = "single" | "parallel" | "pipeline" | "auto";

export interface AgentConfig {
  role: AgentRole;
  name: string;
  model: string;
  systemPrompt: string;
  temperature: number;
}

export interface AgentResult {
  role: AgentRole;
  content: string;
  model: string;
  usage: {
    inputTokens: number;
    outputTokens: number;
  };
}

export interface PipelineStep {
  role: AgentRole;
  /** Optional transform applied to the previous step's output before passing it as input. */
  transform?: (previousOutput: string, originalInput: string) => string;
}

export interface PipelineConfig {
  name: string;
  description: string;
  steps: PipelineStep[];
}

export interface PipelineResult {
  pipeline: string;
  steps: AgentResult[];
  finalOutput: string;
}

export interface OrchestratorRequest {
  mode: ExecutionMode;
  input: string;
  /** Which agent roles to invoke (used for 'single' and 'parallel' modes). */
  roles?: AgentRole[];
  /** Named pipeline to run (used for 'pipeline' mode). */
  pipeline?: string;
}

export interface OrchestratorResponse {
  mode: ExecutionMode;
  results: AgentResult[];
  pipelineResult?: PipelineResult;
}
