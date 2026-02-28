import { getAgentConfig } from "./agents";
import { AgentClient } from "./client";
import type {
  AgentRole,
  ExecutionMode,
  OrchestratorRequest,
  OrchestratorResponse,
  PipelineConfig,
  PipelineResult,
} from "./types";

// ---------------------------------------------------------------------------
// Built-in pipelines
// ---------------------------------------------------------------------------

export const PIPELINES: Record<string, PipelineConfig> = {
  "full-review": {
    name: "full-review",
    description: "Write code, review it, then audit for security issues",
    steps: [
      { role: "code-writer" },
      {
        role: "code-reviewer",
        transform: (prev, orig) =>
          `Original request:\n${orig}\n\nCode produced by the writer:\n${prev}\n\nReview this code.`,
      },
      {
        role: "security-auditor",
        transform: (prev, orig) =>
          `Original request:\n${orig}\n\nCode review notes:\n${prev}\n\nAudit the code and review for security issues.`,
      },
    ],
  },

  "db-first": {
    name: "db-first",
    description: "Design schema first, then implement code, then write tests",
    steps: [
      { role: "database-agent" },
      {
        role: "code-writer",
        transform: (prev, orig) =>
          `Original request:\n${orig}\n\nDatabase schema/migration produced:\n${prev}\n\nImplement the application code for this schema.`,
      },
      {
        role: "testing-agent",
        transform: (prev, orig) =>
          `Original request:\n${orig}\n\nApplication code produced:\n${prev}\n\nWrite tests for this code.`,
      },
    ],
  },

  "security-hardening": {
    name: "security-hardening",
    description: "Audit for vulnerabilities, fix them, then re-audit",
    steps: [
      { role: "security-auditor" },
      {
        role: "code-writer",
        transform: (prev, orig) =>
          `Original request:\n${orig}\n\nSecurity audit findings:\n${prev}\n\nFix all identified vulnerabilities.`,
      },
      {
        role: "security-auditor",
        transform: (prev, orig) =>
          `Original request:\n${orig}\n\nPatched code:\n${prev}\n\nRe-audit to confirm all vulnerabilities are resolved.`,
      },
    ],
  },

  "write-and-test": {
    name: "write-and-test",
    description: "Write code then generate tests for it",
    steps: [
      { role: "code-writer" },
      {
        role: "testing-agent",
        transform: (prev, orig) =>
          `Original request:\n${orig}\n\nCode produced:\n${prev}\n\nWrite comprehensive tests for this code.`,
      },
    ],
  },
};

// ---------------------------------------------------------------------------
// Auto-routing keyword map
// ---------------------------------------------------------------------------

const AUTO_ROUTE_KEYWORDS: Record<string, AgentRole[] | string> = {
  // Single-role keywords
  test: ["testing-agent"],
  vitest: ["testing-agent"],
  playwright: ["testing-agent"],
  spec: ["testing-agent"],
  migration: ["database-agent"],
  schema: ["database-agent"],
  rls: ["database-agent"],
  index: ["database-agent"],
  sql: ["database-agent"],
  vulnerability: ["security-auditor"],
  security: ["security-auditor"],
  audit: ["security-auditor"],
  owasp: ["security-auditor"],
  injection: ["security-auditor"],
  xss: ["security-auditor"],
  review: ["code-reviewer"],

  // Pipeline keywords
  "full review": "full-review",
  "review and secure": "full-review",
  "db first": "db-first",
  "database first": "db-first",
  harden: "security-hardening",
  "security hardening": "security-hardening",
  "write and test": "write-and-test",
  "implement and test": "write-and-test",
};

function autoRoute(input: string): { mode: ExecutionMode; roles?: AgentRole[]; pipeline?: string } {
  const lower = input.toLowerCase();

  // Check multi-word keywords first (longer matches take priority)
  const multiWord = Object.entries(AUTO_ROUTE_KEYWORDS)
    .filter(([kw]) => kw.includes(" "))
    .sort(([a], [b]) => b.length - a.length);

  for (const [keyword, value] of multiWord) {
    if (lower.includes(keyword)) {
      if (typeof value === "string") {
        return { mode: "pipeline", pipeline: value };
      }
      return { mode: value.length === 1 ? "single" : "parallel", roles: value };
    }
  }

  // Then single-word keywords
  const matched = new Set<AgentRole>();
  for (const [keyword, value] of Object.entries(AUTO_ROUTE_KEYWORDS)) {
    if (keyword.includes(" ")) continue;
    if (lower.includes(keyword)) {
      if (typeof value === "string") {
        return { mode: "pipeline", pipeline: value };
      }
      for (const role of value) matched.add(role);
    }
  }

  if (matched.size === 0) {
    // Default to code-writer for general requests
    return { mode: "single", roles: ["code-writer"] };
  }

  const roles = [...matched];
  return { mode: roles.length === 1 ? "single" : "parallel", roles };
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

export class Orchestrator {
  private client: AgentClient;

  constructor(apiKey?: string) {
    this.client = new AgentClient(apiKey);
  }

  async run(request: OrchestratorRequest): Promise<OrchestratorResponse> {
    switch (request.mode) {
      case "single":
        return this.runSingle(request);
      case "parallel":
        return this.runParallel(request);
      case "pipeline":
        return this.runPipeline(request);
      case "auto":
        return this.runAuto(request);
    }
  }

  private async runSingle(request: OrchestratorRequest): Promise<OrchestratorResponse> {
    const role = request.roles?.[0] ?? "code-writer";
    const config = getAgentConfig(role);
    const result = await this.client.callAgent(config, request.input);
    return { mode: "single", results: [result] };
  }

  private async runParallel(request: OrchestratorRequest): Promise<OrchestratorResponse> {
    const roles = request.roles ?? ["code-writer", "code-reviewer"];
    const configs = roles.map(getAgentConfig);
    const results = await this.client.callAgentsParallel(configs, request.input);
    return { mode: "parallel", results };
  }

  private async runPipeline(request: OrchestratorRequest): Promise<OrchestratorResponse> {
    const pipelineName = request.pipeline ?? "full-review";
    const pipeline = PIPELINES[pipelineName];
    if (!pipeline) {
      throw new Error(`Unknown pipeline: ${pipelineName}. Available: ${Object.keys(PIPELINES).join(", ")}`);
    }

    const pipelineResult = await this.executePipeline(pipeline, request.input);
    return {
      mode: "pipeline",
      results: pipelineResult.steps,
      pipelineResult,
    };
  }

  private async runAuto(request: OrchestratorRequest): Promise<OrchestratorResponse> {
    const routed = autoRoute(request.input);

    if (routed.pipeline) {
      return this.runPipeline({ ...request, mode: "pipeline", pipeline: routed.pipeline });
    }

    if (routed.roles && routed.roles.length > 1) {
      return this.runParallel({ ...request, mode: "parallel", roles: routed.roles });
    }

    return this.runSingle({ ...request, mode: "single", roles: routed.roles });
  }

  private async executePipeline(
    pipeline: PipelineConfig,
    originalInput: string,
  ): Promise<PipelineResult> {
    const steps: import("./types").AgentResult[] = [];
    let currentInput = originalInput;

    for (const step of pipeline.steps) {
      const config = getAgentConfig(step.role);
      const input = step.transform
        ? step.transform(currentInput, originalInput)
        : currentInput;

      const result = await this.client.callAgent(config, input);
      steps.push(result);
      currentInput = result.content;
    }

    return {
      pipeline: pipeline.name,
      steps,
      finalOutput: currentInput,
    };
  }
}

export function getPipelineNames(): string[] {
  return Object.keys(PIPELINES);
}

export function getPipelineConfig(name: string): PipelineConfig | undefined {
  return PIPELINES[name];
}
