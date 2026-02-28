import Anthropic from "@anthropic-ai/sdk";
import type { AgentConfig, AgentResult } from "./types";

export class AgentClient {
  private client: Anthropic;

  constructor(apiKey?: string) {
    this.client = new Anthropic({
      apiKey: apiKey ?? process.env.ANTHROPIC_API_KEY,
    });
  }

  async callAgent(config: AgentConfig, userMessage: string): Promise<AgentResult> {
    const response = await this.client.messages.create({
      model: config.model,
      max_tokens: 4096,
      temperature: config.temperature,
      system: config.systemPrompt,
      messages: [{ role: "user", content: userMessage }],
    });

    const content = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === "text")
      .map((block) => block.text)
      .join("\n");

    return {
      role: config.role,
      content,
      model: response.model,
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
      },
    };
  }

  async callAgentsParallel(
    configs: AgentConfig[],
    userMessage: string,
  ): Promise<AgentResult[]> {
    const promises = configs.map((config) => this.callAgent(config, userMessage));
    return Promise.all(promises);
  }
}
