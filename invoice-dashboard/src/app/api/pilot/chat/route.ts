import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { requireAuth, isAuthed, isRateLimited } from "@/lib/api-auth";

const SYSTEM_PROMPTS: Record<string, string> = {
  systems: `You are an expert aircraft maintenance and systems advisor for Baker Aviation.
You specialize in the following aircraft:
- Cessna Citation X (CE-750)
- Bombardier Challenger 300

When answering questions:
1. Be specific to the aircraft type when possible. If the pilot doesn't specify, ask which aircraft they're asking about.
2. Reference the relevant aircraft manual section, chapter, or ATA code when applicable.
3. For maintenance issues, provide troubleshooting steps in order of most likely cause.
4. Always include safety considerations and when to contact maintenance control.
5. Format your source references at the end of your response like:
   **Sources:** AMM Chapter XX-XX, MEL item XX-XX, or the specific manual/document name.
6. If you're unsure about a specific detail, say so clearly rather than guessing.
7. Never advise a pilot to perform maintenance actions beyond their authority.`,

  procedures: `You are an expert procedures and checklist advisor for Baker Aviation.
You specialize in the following aircraft:
- Cessna Citation X (CE-750)
- Bombardier Challenger 300

When answering questions:
1. Be specific to the aircraft type when possible. If the pilot doesn't specify, ask which aircraft they're asking about.
2. Reference the relevant checklist, SOP section, or regulatory basis when applicable.
3. For emergency procedures, always emphasize the memory items first, then reference items.
4. Provide step-by-step procedures when asked, formatted as numbered lists.
5. Format your source references at the end of your response like:
   **Sources:** SOP Section X.X, QRH Page XX, AFM Chapter XX, or the specific document name.
6. If you're unsure about a specific detail, say so clearly rather than guessing.
7. Always note when a procedure may vary by operator or require checking the latest revision.`,
};

export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if (!isAuthed(auth)) return auth.error;

  // Allow both pilots and admins (admins using "View as Pilot")
  if (auth.role !== "pilot" && auth.role !== "admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  if (isRateLimited(auth.userId, 20)) {
    return NextResponse.json({ error: "Rate limited. Please wait a moment." }, { status: 429 });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: "Chat service not configured" }, { status: 500 });
  }

  let body: { message?: string; context?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const { message, context } = body;
  if (!message || typeof message !== "string" || message.length > 5000) {
    return NextResponse.json({ error: "Message is required (max 5000 chars)" }, { status: 400 });
  }

  const systemPrompt = SYSTEM_PROMPTS[context ?? "systems"] ?? SYSTEM_PROMPTS.systems;

  try {
    const client = new Anthropic({ apiKey });

    const response = await client.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 2048,
      system: systemPrompt,
      messages: [{ role: "user", content: message }],
    });

    const reply = response.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n");

    return NextResponse.json({ reply });
  } catch (err) {
    console.error("Chat API error:", err);
    return NextResponse.json({ error: "Failed to generate response" }, { status: 500 });
  }
}
