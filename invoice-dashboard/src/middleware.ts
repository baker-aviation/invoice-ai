import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

function unauthorized() {
  return new NextResponse("Authentication required", {
    status: 401,
    headers: {
      "WWW-Authenticate": 'Basic realm="Secure Demo"',
    },
  });
}

function loadUsers(): Array<{ user: string; pass: string }> {
  // Multi-user: DEMO_USERS=alice:pass1,bob:pass2
  const multi = process.env.DEMO_USERS;
  if (multi) {
    return multi.split(",").flatMap((entry) => {
      const colon = entry.indexOf(":");
      if (colon === -1) return [];
      return [{ user: entry.slice(0, colon).trim(), pass: entry.slice(colon + 1).trim() }];
    });
  }
  // Single-user fallback: DEMO_USER + DEMO_PASS
  const user = process.env.DEMO_USER;
  const pass = process.env.DEMO_PASS;
  if (user && pass) return [{ user, pass }];
  return [];
}

export function middleware(req: NextRequest) {
  const users = loadUsers();

  if (users.length === 0) {
    return unauthorized();
  }

  const auth = req.headers.get("authorization");

  if (!auth?.startsWith("Basic ")) {
    return unauthorized();
  }

  const base64 = auth.split(" ")[1];
  const decoded = Buffer.from(base64, "base64").toString("utf-8");
  const colon = decoded.indexOf(":");
  const u = decoded.slice(0, colon);
  const p = decoded.slice(colon + 1);

  if (users.some((entry) => entry.user === u && entry.pass === p)) {
    return NextResponse.next();
  }

  return unauthorized();
}

export const config = {
  matcher: ["/((?!_next|favicon.ico).*)"],
};