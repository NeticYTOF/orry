/* GET /api/health: the site process is up. Public and near-free: it reads nothing and says nothing about Orry. */
export const dynamic = "force-dynamic";

export function GET() {
  return Response.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
}
