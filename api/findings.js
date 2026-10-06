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

    // Attach the exact observation wording to every finding.  Reports and
    // corrective-plan screens must never replace the real observation with a
    // short checklist code such as QMPS-1.
    const observationIds = [...new Set(findings.map(f => f.observation_id).filter(Boolean))];
    let observations = [];
    if (observationIds.length) {
      observations = await sbGet("observations", `?id=in.(${observationIds.join(",")})`);
    }
    const byObservation = Object.fromEntries(observations.map(o => [String(o.id), o]));
    const merged = findings.map((f) => {
      const obs = byObservation[String(f.observation_id)] || null;
      return {
        ...f,
        observation_text: obs?.observation_text || null,
        observation_location: obs?.location || null,
        immediate_action: obs?.immediate_action || null,
        suggested_action: obs?.suggested_action || null,
        observation_comments: obs?.comments || null,
        plan: byFinding[f.id] || null
      };
    });

    return res.status(200).json({ success: true, findings: merged });
  } catch (error) {
    if (handleConfigError(res, error)) return;
    console.error("findings API error:", error);
    return res.status(500).json({ success: false, error: error.message || "Internal server error" });
  }
}
