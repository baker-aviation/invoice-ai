import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { requireAuth, isAuthed, isRateLimited } from "@/lib/api-auth";

const SYSTEM_PROMPTS: Record<string, string> = {
  "citation-x": `You are an expert aviation advisor for Baker Aviation, specializing in the Cessna Citation X (CE-750).
You cover all topics for this aircraft: systems, maintenance, MEL items, procedures, checklists, SOPs, and emergency procedures.

When answering questions:
1. All answers should be specific to the Citation X (CE-750).
2. Reference the relevant manual section, ATA code, checklist, or SOP section when applicable.
3. For maintenance issues, provide troubleshooting steps in order of most likely cause.
4. For emergency procedures, always emphasize the memory items first, then reference items.
5. Always include safety considerations and when to contact maintenance control.
6. If you're unsure about a specific detail, say so clearly rather than guessing.
7. Never advise a pilot to perform maintenance actions beyond their authority.`,

  "challenger-300": `You are an expert aviation advisor for Baker Aviation, specializing in the Bombardier Challenger 300.
You cover all topics for this aircraft: systems, maintenance, MEL items, procedures, checklists, SOPs, and emergency procedures.

When answering questions:
1. All answers should be specific to the Challenger 300.
2. Reference the relevant manual section, ATA code, checklist, or SOP section when applicable.
3. For maintenance issues, provide troubleshooting steps in order of most likely cause.
4. For emergency procedures, always emphasize the memory items first, then reference items.
5. Always include safety considerations and when to contact maintenance control.
6. If you're unsure about a specific detail, say so clearly rather than guessing.
7. Never advise a pilot to perform maintenance actions beyond their authority.`,
};

export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if (!isAuthed(auth)) return auth.error;

  // Allow both pilots and admins (admins using "View as Pilot")
  if (auth.role !== "pilot" && auth.role !== "admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  if (await isRateLimited(auth.userId, 20)) {
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

  let systemPrompt = SYSTEM_PROMPTS[context ?? "citation-x"] ?? SYSTEM_PROMPTS["citation-x"];
  let sources: { title: string; category: string }[] = [];

  // RAG: retrieve relevant document chunks and inject into system prompt
  try {
    const { retrieveChunks, formatContextBlock } = await import("@/lib/rag");
    const chunks = await retrieveChunks(message, 5);
    const contextBlock = formatContextBlock(chunks);
    if (contextBlock) {
      systemPrompt += contextBlock;
    }
    // Extract unique sources from retrieved chunks
    const seen = new Set<string>();
    for (const chunk of chunks) {
      const key = chunk.document_title;
      if (key && !seen.has(key)) {
        seen.add(key);
        sources.push({ title: chunk.document_title, category: chunk.document_category });
      }
    }
  } catch (err) {
    // Graceful degradation: if retrieval fails, chat works as before
    console.warn("[pilot-chat] RAG retrieval failed, continuing without context:", err);
  }

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

    return NextResponse.json({ reply, sources });
  } catch (err) {
    console.error("Chat API error:", err);
    return NextResponse.json({ error: "Failed to generate response" }, { status: 500 });
  }
}
