/**
 * TEMPORARY test endpoint — DELETE after verifying agent execution works.
 * Bypasses admin auth to allow curl testing from the terminal.
 */
import { NextRequest, NextResponse } from "next/server";
import { Orchestrator } from "@agents/index";

export async function POST(req: NextRequest) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: "ANTHROPIC_API_KEY not set" }, { status: 503 });
  }

  const body = await req.json();
  const orchestrator = new Orchestrator(apiKey);

  try {
    const response = await orchestrator.run({
      mode: "single",
      input: body.input ?? "Write a hello world function in TypeScript",
      roles: ["code-writer"],
    });
    return NextResponse.json(response);
  } catch (e: unknown) {
    console.error("Test agent failed:", e);
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Agent execution failed" },
      { status: 502 },
    );
  }
}
