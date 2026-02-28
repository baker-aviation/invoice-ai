import type { AgentConfig, AgentRole } from "./types";

const MODEL = "claude-sonnet-4-20250514";

/**
 * Environment variable names for each agent's system prompt.
 * Prompts MUST be loaded from env vars — never hardcode them in source.
 */
const PROMPT_ENV_VARS: Record<AgentRole, string> = {
  "code-writer": "AGENT_PROMPT_CODE_WRITER",
  "code-reviewer": "AGENT_PROMPT_CODE_REVIEWER",
  "security-auditor": "AGENT_PROMPT_SECURITY_AUDITOR",
  "database-agent": "AGENT_PROMPT_DATABASE_AGENT",
  "testing-agent": "AGENT_PROMPT_TESTING_AGENT",
};

function loadPrompt(role: AgentRole): string {
  const envVar = PROMPT_ENV_VARS[role];
  const prompt = process.env[envVar];
  if (!prompt) {
    throw new Error(`Missing env var ${envVar} for agent "${role}". Set all AGENT_PROMPT_* env vars.`);
  }
  return prompt;
}

function buildConfigs(): Record<AgentRole, AgentConfig> {
  return {
    "code-writer": {
      role: "code-writer",
      name: "Code Writer",
      model: MODEL,
      temperature: 0.3,
      systemPrompt: loadPrompt("code-writer"),
    },
    "code-reviewer": {
      role: "code-reviewer",
      name: "Code Reviewer",
      model: MODEL,
      temperature: 0.2,
      systemPrompt: loadPrompt("code-reviewer"),
    },
    "security-auditor": {
      role: "security-auditor",
      name: "Security Auditor",
      model: MODEL,
      temperature: 0.1,
      systemPrompt: loadPrompt("security-auditor"),
    },
    "database-agent": {
      role: "database-agent",
      name: "Database Agent",
      model: MODEL,
      temperature: 0.2,
      systemPrompt: loadPrompt("database-agent"),
    },
    "testing-agent": {
      role: "testing-agent",
      name: "Testing Agent",
      model: MODEL,
      temperature: 0.2,
      systemPrompt: loadPrompt("testing-agent"),
    },
  };
}

/** Lazy-loaded configs — built on first access so env vars are available at runtime. */
let _configs: Record<AgentRole, AgentConfig> | null = null;

export function getAgentConfigs(): Record<AgentRole, AgentConfig> {
  if (!_configs) _configs = buildConfigs();
  return _configs;
}

export function getAgentConfig(role: AgentRole): AgentConfig {
  return getAgentConfigs()[role];
}

export function getAllAgentConfigs(): AgentConfig[] {
  return Object.values(getAgentConfigs());
}

/** Agent metadata safe for public listing (no system prompts). */
export function getAgentMeta(): { role: AgentRole; name: string; model: string }[] {
  const roles: AgentRole[] = [
    "code-writer",
    "code-reviewer",
    "security-auditor",
    "database-agent",
    "testing-agent",
  ];
  return roles.map((role) => ({
    role,
    name: PROMPT_ENV_VARS[role].replace("AGENT_PROMPT_", "").replace(/_/g, " "),
    model: MODEL,
  }));
}
