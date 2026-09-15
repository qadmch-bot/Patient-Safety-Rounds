import { sbGet, setCors, handleConfigError } from "../lib/supabase.js";

// GET /api/previous-findings?department=XXX[&exclude_round_id=YYY]
//   -> { findings: [...] } — every approved finding on record for that
//      department, each classified into exactly one follow_up_status:
//        closed_sustained | still_open | overdue | recurred
//      (recurred = a later finding matching the same department+domain+
//      checklist_item exists, i.e. this one came back). Each finding also
//      carries its own is_recurring flag (true if IT was itself a repeat
//      of something even earlier), matching the spec's separate
//      "Recurring Finding" callout.
//
// Used by: (a) the Previous Round Follow-up section on the secure,
// no-login round page, and (b) the same section inside the main system
// when Quality opens a round for a department.

function classify(finding, allForKey, today) {
  const laterExists = allForKey.some((f) => f.id !== finding.id && new Date(f.created_at) > new Date(finding.created_at));
  if (laterExists) return "recurred";
  if (finding.status === "Closed") return "closed_sustained";
  const plan = finding.plan;
  if (plan && plan.due_date && new Date(plan.due_date) < today && finding.status !== "Closed") return "overdue";
  return "still_open";
}

export default async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ success: false, error: "Method not allowed" });

  try {
    const department = req.query.department;
    if (!department) return res.status(400).json({ success: false, error: "department is required." });

    let query = `?department=eq.${encodeURIComponent(department)}&order=created_at.desc`;
    if (req.query.exclude_round_id) query += `&round_id=neq.${encodeURIComponent(req.query.exclude_round_id)}`;
    const findings = await sbGet("findings", query);

    const findingIds = findings.map((f) => f.id);
    let plans = [];
    if (findingIds.length) {
      plans = await sbGet("improvement_plans", `?finding_id=in.(${findingIds.join(",")})`);
    }
    const planByFinding = Object.fromEntries(plans.map((p) => [p.finding_id, p]));
    findings.forEach((f) => { f.plan = planByFinding[f.id] || null; });

    // Group by department+domain+checklist_item to find "later" matches for recurrence.
    const byKey = {};
    findings.forEach((f) => {
      const key = `${f.department}|${f.domain}|${f.checklist_item}`;
      (byKey[key] = byKey[key] || []).push(f);
    });

    const today = new Date();
    const result = findings.map((f) => {
      const key = `${f.department}|${f.domain}|${f.checklist_item}`;
      return Object.assign({}, f, { follow_up_status: classify(f, byKey[key], today) });
    });

    return res.status(200).json({ success: true, findings: result });
  } catch (error) {
    if (handleConfigError(res, error)) return;
    console.error("previous-findings API error:", error);
    return res.status(500).json({ success: false, error: error.message || "Internal server error" });
  }
}
