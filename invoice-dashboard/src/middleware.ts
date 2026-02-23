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

export function middleware(req: NextRequest) {
  const user = process.env.DEMO_USER;
  const pass = process.env.DEMO_PASS;

  if (!user || !pass) {
    return unauthorized();
  }

  const auth = req.headers.get("authorization");

  if (!auth?.startsWith("Basic ")) {
    return unauthorized();
  }

  const base64 = auth.split(" ")[1];
  const decoded = Buffer.from(base64, "base64").toString("utf-8");
  const [u, p] = decoded.split(":");

  if (u === user && p === pass) {
    return NextResponse.next();
  }

  return unauthorized();
}

export const config = {
  matcher: ["/((?!_next|favicon.ico).*)"],
};