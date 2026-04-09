import { NextRequest, NextResponse } from "next/server";
import { requireSuperAdmin, isAuthed } from "@/lib/api-auth";

export const dynamic = "force-dynamic";

const REPO_OWNER = "baker-aviation";
const REPO_NAME = "invoice-ai";

function ghHeaders(): Record<string, string> {
  const h: Record<string, string> = { Accept: "application/vnd.github.v3+json" };
  const token = process.env.GITHUB_TOKEN;
  if (token) h.Authorization = `Bearer ${token}`;
  return h;
}

async function fetchWithRetry(url: string): Promise<Response> {
  let res = await fetch(url, { headers: ghHeaders(), next: { revalidate: 3600 } });
  // GitHub returns 202 while computing stats — retry up to 3 times
  for (let i = 0; i < 3 && res.status === 202; i++) {
    await new Promise(r => setTimeout(r, 2000));
    res = await fetch(url, { headers: ghHeaders(), next: { revalidate: 3600 } });
  }
  return res;
}

export async function GET(req: NextRequest) {
  const auth = await requireSuperAdmin(req);
  if (!isAuthed(auth)) return auth.error;

  let totalAdded = 0;
  let totalDeleted = 0;
  let totalCommits = 0;
  let currentLines = 0;
  const contributors: { name: string; commits: number; added: number; deleted: number }[] = [];

  // 1. GitHub contributor stats (total lines written)
  try {
    const res = await fetchWithRetry(
      `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/stats/contributors`
    );
    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data)) {
        for (const c of data) {
          let added = 0, deleted = 0, commits = 0;
          for (const week of c.weeks ?? []) {
            added += week.a ?? 0;
            deleted += week.d ?? 0;
            commits += week.c ?? 0;
          }
          totalAdded += added;
          totalDeleted += deleted;
          totalCommits += commits;
          contributors.push({
            name: c.author?.login ?? "unknown",
            commits,
            added,
            deleted,
          });
        }
        contributors.sort((a, b) => b.added - a.added);
        // Net surviving lines = added - deleted
        currentLines = totalAdded - totalDeleted;
      }
    }
  } catch {
    // GitHub API unavailable — stats will be 0
  }

  return NextResponse.json({
    currentLines,
    totalAdded,
    totalDeleted,
    totalCommits,
    contributors,
  });
}
