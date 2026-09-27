/**
 * DELETE /api/sessions/:id — clear chat history for a session.
 * GET    /api/sessions/:id — fetch prior messages for a session.
 */

import { NextResponse } from "next/server";
import { clearSession, getSessionMessages } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const messages = await getSessionMessages(id);
  return NextResponse.json({ messages });
}

export async function DELETE(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  await clearSession(id);
  return NextResponse.json({ ok: true });
}
