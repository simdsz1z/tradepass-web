/** GET /api/sources — list all source snippets (for the UI sidebar / count). */
import { NextResponse } from "next/server";
import { getAllSources } from "@/lib/db";
import type { SourcesResponse } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse<SourcesResponse>> {
  const sources = await getAllSources();
  return NextResponse.json({ sources });
}
