import { NextResponse, type NextRequest } from "next/server";
import { isLoopbackHost } from "@/app/_server/loopback";

// Runs before every route (pages, API, static): a non-loopback Host is refused outright.
export function proxy(req: NextRequest) {
  if (isLoopbackHost(req.headers.get("host") ?? "")) return NextResponse.next();
  return NextResponse.json({ code: "FORBIDDEN", message: "requests must target a loopback host" }, { status: 403 });
}
