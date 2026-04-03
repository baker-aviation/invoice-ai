import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { requireAdmin, isAuthed, isRateLimited } from "@/lib/api-auth";
import { signGcsUrl } from "@/lib/gcs";
import OpenAI from "openai";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const PRD_EXTRACTION_PROMPT = `You are analyzing a FAA Pilot Records Database (PRD) document for a hiring review.

Extract the following structured data from this PRD document. Be precise and factual — only report what is explicitly stated in the document.

**Flags to check (set to true only if records exist, not "no records on file"):**
- failed_checkrides: Are there any Notices of Disapproval (failed practical tests)?
- notices_of_disapproval_count: How many failed checkrides total?
- accidents: Are there any accidents listed?
- accidents_count: How many accidents?
- incidents: Are there any incidents listed?
- enforcements: Are there any enforcement actions?
- terminations_for_cause: In the Air Carrier Data / employer records, was the pilot terminated for cause (e.g., "Termination - Pilot Performance", "Termination - Conduct")?
- drug_alcohol_faa: Any FAA drug/alcohol records?
- drug_alcohol_employer: Any employer-reported drug/alcohol records?
- disciplinary_actions: Any final disciplinary actions from employers?
- unsatisfactory_training: Any training events with "Unsatisfactory" or "Incomplete" results?
- short_tenures: Any employment stints shorter than 6 months?

**flag_details**: A brief bullet-point list of ONLY the concerning items found. Include dates, employers, aircraft types. If no flags, write "Clean record — no flags."

**summary**: A 2-3 sentence executive summary for the hiring manager. Include: certificate level, key type ratings, total employers, any notable flags. Be concise.

**Certificate info:**
- certificate_type: e.g., "Airline Transport Pilot", "Commercial"
- certificate_number: The FAA certificate number
- medical_class: e.g., "First", "Second", "Third"
- medical_date: The medical certificate date (MM/DD/YYYY)
- medical_limitations: Any medical limitations, or "None"

**Type ratings**: List ALL type ratings from the Pilot Certificate Information section. Use the exact FAA codes (e.g., "CE-750", "CL-30", "B-737").

**SIC limitations**: List any type ratings that have SIC-only limitations (e.g., "CL-600 SIC ONLY", "LR-JET SIC ONLY").

**Employment history**: List employers with hire date, separation date, separation type. Note any gaps > 6 months.`;

const EXTRACTION_SCHEMA = {
  type: "object" as const,
  properties: {
    flags: {
      type: "object" as const,
      properties: {
        failed_checkrides: { type: "boolean" as const },
        notices_of_disapproval_count: { type: "number" as const },
        accidents: { type: "boolean" as const },
        accidents_count: { type: "number" as const },
        incidents: { type: "boolean" as const },
        enforcements: { type: "boolean" as const },
        terminations_for_cause: { type: "boolean" as const },
        drug_alcohol_faa: { type: "boolean" as const },
        drug_alcohol_employer: { type: "boolean" as const },
        disciplinary_actions: { type: "boolean" as const },
        unsatisfactory_training: { type: "boolean" as const },
        short_tenures: { type: "boolean" as const },
        flag_details: { type: "string" as const },
      },
      required: [
        "failed_checkrides", "notices_of_disapproval_count",
        "accidents", "accidents_count", "incidents", "enforcements",
        "terminations_for_cause", "drug_alcohol_faa", "drug_alcohol_employer",
        "disciplinary_actions", "unsatisfactory_training", "short_tenures",
        "flag_details",
      ],
    },
    summary: { type: "string" as const },
    certificate: {
      type: "object" as const,
      properties: {
        certificate_type: { type: "string" as const },
        certificate_number: { type: "string" as const },
        medical_class: { type: "string" as const },
        medical_date: { type: "string" as const },
        medical_limitations: { type: "string" as const },
      },
      required: ["certificate_type", "certificate_number", "medical_class", "medical_date", "medical_limitations"],
    },
    type_ratings: {
      type: "array" as const,
      items: { type: "string" as const },
    },
    sic_limitations: {
      type: "array" as const,
      items: { type: "string" as const },
    },
  },
  required: ["flags", "summary", "certificate", "type_ratings", "sic_limitations"],
};

/** Check if a type rating indicates Citation X (CE-750). */
function isCitationX(rating: string): boolean {
  const r = rating.toUpperCase();
  return r.includes("CE-750") || r.includes("C750") || r === "CITATION X";
}

/** Check if a type rating indicates Challenger 300/350 (CL-30). */
function isChallenger300(rating: string): boolean {
  const r = rating.toUpperCase();
  return r.includes("CL-30") || r === "CL30" || r.includes("CHALLENGER 3");
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireAdmin(req);
  if (!isAuthed(auth)) return auth.error;
  if (await isRateLimited(auth.userId, 5)) {
    return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
  }

  const { id } = await params;
  const applicationId = Number(id);
  if (!applicationId || isNaN(applicationId)) {
    return NextResponse.json({ error: "Invalid application ID" }, { status: 400 });
  }

  const supa = createServiceClient();

  try {
    // Find the PRD file for this application
    const { data: prdFiles } = await supa
      .from("job_application_files")
      .select("id, gcs_bucket, gcs_key, filename")
      .eq("application_id", applicationId)
      .eq("file_category", "prd")
      .order("created_at", { ascending: false })
      .limit(1);

    if (!prdFiles || prdFiles.length === 0) {
      return NextResponse.json({ error: "No PRD file found for this application" }, { status: 404 });
    }

    const prdFile = prdFiles[0];

    // Download the PDF from GCS
    const { Storage } = await import("@google-cloud/storage");
    let storage: InstanceType<typeof Storage>;
    const b64Key = process.env.GCP_SERVICE_ACCOUNT_KEY;
    if (b64Key) {
      let creds: Record<string, unknown>;
      try { creds = JSON.parse(b64Key); } catch { creds = JSON.parse(Buffer.from(b64Key, "base64").toString("utf-8")); }
      storage = new Storage({ credentials: creds, projectId: creds.project_id as string });
    } else {
      storage = new Storage();
    }

    const bucket = storage.bucket(prdFile.gcs_bucket);
    const [buffer] = await bucket.file(prdFile.gcs_key).download();

    // Extract text from PDF
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const pdfParse = require("pdf-parse") as (buf: Buffer) => Promise<{ text: string; numpages: number }>;
    const pdf = await pdfParse(buffer);
    const pdfText = pdf.text;

    if (!pdfText || pdfText.trim().length < 100) {
      return NextResponse.json({ error: "Could not extract text from PRD PDF" }, { status: 422 });
    }

    // Send to OpenAI for structured extraction
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    const completion = await openai.chat.completions.create({
      model: "gpt-4o",
      temperature: 0,
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "prd_extraction",
          strict: true,
          schema: EXTRACTION_SCHEMA,
        },
      },
      messages: [
        { role: "system", content: PRD_EXTRACTION_PROMPT },
        { role: "user", content: `Here is the full text of the PRD document:\n\n${pdfText.slice(0, 30000)}` },
      ],
    });

    const content = completion.choices[0]?.message?.content;
    if (!content) {
      return NextResponse.json({ error: "OpenAI returned empty response" }, { status: 500 });
    }

    const parsed = JSON.parse(content);

    // Determine type rating enrichment
    const faaTypeRatings = (parsed.type_ratings ?? []) as string[];
    const hasCitX = faaTypeRatings.some(isCitationX);
    const hasChal = faaTypeRatings.some(isChallenger300);

    // Find the parse row for this application
    const { data: parseRow } = await supa
      .from("job_application_parse")
      .select("id")
      .eq("application_id", applicationId)
      .is("deleted_at", null)
      .limit(1)
      .single();

    if (!parseRow) {
      return NextResponse.json({ error: "No parse row found" }, { status: 404 });
    }

    // Update the parse row with PRD data
    const { error: updateErr } = await supa
      .from("job_application_parse")
      .update({
        prd_flags: parsed.flags,
        prd_summary: parsed.summary,
        prd_type_ratings: faaTypeRatings,
        prd_sic_limitations: parsed.sic_limitations ?? [],
        prd_parsed_at: new Date().toISOString(),
        prd_certificate_type: parsed.certificate?.certificate_type ?? null,
        prd_certificate_number: parsed.certificate?.certificate_number ?? null,
        prd_medical_class: parsed.certificate?.medical_class ?? null,
        prd_medical_date: parsed.certificate?.medical_date ?? null,
        prd_medical_limitations: parsed.certificate?.medical_limitations ?? null,
        // Enrich existing type rating fields with FAA-verified data
        type_ratings: faaTypeRatings,
        has_citation_x: hasCitX,
        has_challenger_300_type_rating: hasChal,
        updated_at: new Date().toISOString(),
      })
      .eq("id", parseRow.id);

    if (updateErr) {
      console.error("[parse-prd] Update failed:", updateErr);
      return NextResponse.json({ error: `DB update failed: ${updateErr.message}` }, { status: 500 });
    }

    return NextResponse.json({
      ok: true,
      application_id: applicationId,
      flags: parsed.flags,
      summary: parsed.summary,
      type_ratings: faaTypeRatings,
      sic_limitations: parsed.sic_limitations,
    });
  } catch (err: any) {
    console.error("[parse-prd] Error:", err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
