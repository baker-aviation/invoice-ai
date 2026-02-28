import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { z } from "zod";
import { Orchestrator, PIPELINES, getAgentMeta } from "@agents/index";
import type { AgentRole, ExecutionMode } from "@agents/types";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const VALID_ROLES: AgentRole[] = [
  "code-writer",
  "code-reviewer",
  "security-auditor",
  "database-agent",
  "testing-agent",
];
const VALID_MODES: ExecutionMode[] = ["single", "parallel", "pipeline", "auto"];
const MAX_INPUT_LENGTH = 10_000;
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 10;

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
// In-memory rate limiter (per-user, sliding window)
// ---------------------------------------------------------------------------

const rateLimitMap = new Map<string, number[]>();

function isRateLimited(userId: string): boolean {
  const now = Date.now();
  const timestamps = rateLimitMap.get(userId) ?? [];
  const recent = timestamps.filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
  rateLimitMap.set(userId, recent);

  if (recent.length >= RATE_LIMIT_MAX) return true;

  recent.push(now);
  rateLimitMap.set(userId, recent);
  return false;
}

// ---------------------------------------------------------------------------
// Auth helper — validates Supabase session + admin role
// ---------------------------------------------------------------------------

async function getAuthenticatedAdmin(req: NextRequest): Promise<
  { userId: string } | { error: NextResponse }
> {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!supabaseUrl || !supabaseAnonKey) {
    return { error: NextResponse.json({ error: "Server misconfiguration" }, { status: 500 }) };
  }

  const supabase = createServerClient(supabaseUrl, supabaseAnonKey, {
    cookies: {
      getAll() {
        return req.cookies.getAll();
      },
      setAll() {
        // Read-only in API routes — no-op
      },
    },
  });

  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();

  if (error || !user) {
    return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  }

  const role =
    (user.app_metadata?.role as string | undefined) ??
    (user.user_metadata?.role as string | undefined);

  if (role !== "admin") {
    return { error: NextResponse.json({ error: "Forbidden — admin role required" }, { status: 403 }) };
  }

  return { userId: user.id };
}

// ---------------------------------------------------------------------------
// Env check
// ---------------------------------------------------------------------------

function mustApiKey(): string {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("Missing ANTHROPIC_API_KEY");
  return key;
}

// ---------------------------------------------------------------------------
// POST /api/agents — run orchestrator
// ---------------------------------------------------------------------------

export async function POST(req: NextRequest) {
  // 1. Auth: require admin
  const auth = await getAuthenticatedAdmin(req);
  if ("error" in auth) return auth.error;

  // 2. Rate limit
  if (isRateLimited(auth.userId)) {
    return NextResponse.json(
      { error: "Rate limit exceeded — max 10 requests per minute" },
      { status: 429 },
    );
  }

  // 3. API key
  let apiKey: string;
  try {
    apiKey = mustApiKey();
  } catch {
    return NextResponse.json({ error: "Missing ANTHROPIC_API_KEY" }, { status: 500 });
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
    const message = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: message }, { status: 502 });
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
