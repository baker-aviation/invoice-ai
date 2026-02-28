import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { Orchestrator, PIPELINES, getAgentMeta } from "@agents/index";
import type { AgentRole, ExecutionMode } from "@agents/types";
import { requireAdmin, isAuthed, isRateLimited } from "@/lib/api-auth";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const VALID_MODES: ExecutionMode[] = ["single", "parallel", "pipeline", "auto"];
const MAX_INPUT_LENGTH = 10_000;

// ---------------------------------------------------------------------------
// Zod schema
// ---------------------------------------------------------------------------

const AgentRequestSchema = z.object({
  mode: z.enum(["single", "parallel", "pipeline", "auto"]),
  input: z
    .string()
    .min(1, "Input must not be empty")
    .max(MAX_INPUT_LENGTH, `Input must be at most ${MAX_INPUT_LENGTH} characters`),
  roles: z
    .array(z.enum(["code-writer", "code-reviewer", "security-auditor", "database-agent", "testing-agent"]))
    .optional(),
  pipeline: z.string().optional(),
});

// ---------------------------------------------------------------------------
// POST /api/agents — run orchestrator
// ---------------------------------------------------------------------------

export async function POST(req: NextRequest) {
  // 1. Auth: require admin
  const auth = await requireAdmin(req);
  if (!isAuthed(auth)) return auth.error;

  // 2. Rate limit
  if (isRateLimited(auth.userId, 10)) {
    return NextResponse.json(
      { error: "Rate limit exceeded" },
      { status: 429 },
    );
  }

  // 3. API key
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: "Service unavailable" }, { status: 503 });
  }

  // 4. Parse + validate body with Zod
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = AgentRequestSchema.safeParse(body);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
    return NextResponse.json({ error: "Validation failed", details: issues }, { status: 400 });
  }

  const { mode, input, roles, pipeline } = parsed.data;

  if (pipeline && !PIPELINES[pipeline]) {
    return NextResponse.json(
      { error: `Unknown pipeline: ${pipeline}. Available: ${Object.keys(PIPELINES).join(", ")}` },
      { status: 400 },
    );
  }

  // 5. Run orchestrator
  try {
    const orchestrator = new Orchestrator(apiKey);
    const response = await orchestrator.run({
      mode: mode as ExecutionMode,
      input,
      roles: roles as AgentRole[] | undefined,
      pipeline,
    });
    return NextResponse.json(response);
  } catch (e: unknown) {
    console.error("Agent execution failed:", e);
    return NextResponse.json({ error: "Agent execution failed" }, { status: 502 });
  }
}

// ---------------------------------------------------------------------------
// GET /api/agents — list agents & pipelines (public metadata, no prompts)
// ---------------------------------------------------------------------------

export async function GET() {
  return NextResponse.json({
    agents: getAgentMeta(),
    pipelines: Object.values(PIPELINES).map((p) => ({
      name: p.name,
      description: p.description,
      steps: p.steps.map((s) => s.role),
    })),
    modes: VALID_MODES,
  });
}
