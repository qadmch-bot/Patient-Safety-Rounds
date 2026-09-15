import { sbGet, setCors, handleConfigError } from "../lib/supabase.js";

// GET /api/findings                → all findings (optionally ?department=..., ?status=...)
// Each finding row already carries its own `department`, so the client can
// group these into "DEPARTMENT A / Finding 1, 2, 3 — DEPARTMENT B / ..."
// without any extra endpoint; this route just applies the optional filters.

export default async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ success: false, error: "Method not allowed" });

  try {
    let query = "?order=department.asc,created_at.desc";
    if (req.query.department) query += `&department=eq.${encodeURIComponent(req.query.department)}`;
    if (req.query.status) query += `&status=eq.${encodeURIComponent(req.query.status)}`;
    if (req.query.round_id) query += `&round_id=eq.${encodeURIComponent(req.query.round_id)}`;
    if (req.query.exclude_round_id) query += `&round_id=neq.${encodeURIComponent(req.query.exclude_round_id)}`;
    const findings = await sbGet("findings", query);

    // Attach each finding's plan (0 or 1) so the UI doesn't need a second round-trip per row.
    const findingIds = findings.map((f) => f.id);
    let plans = [];
    if (findingIds.length) {
      plans = await sbGet("improvement_plans", `?finding_id=in.(${findingIds.join(",")})`);
    }
    const byFinding = Object.fromEntries(plans.map((p) => [p.finding_id, p]));
    const merged = findings.map((f) => ({ ...f, plan: byFinding[f.id] || null }));

    return res.status(200).json({ success: true, findings: merged });
  } catch (error) {
    if (handleConfigError(res, error)) return;
    console.error("findings API error:", error);
    return res.status(500).json({ success: false, error: error.message || "Internal server error" });
  }
}
