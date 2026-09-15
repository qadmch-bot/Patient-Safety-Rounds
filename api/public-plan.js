import { sbGet, sbInsert, sbPatch, logAudit, setCors, handleConfigError } from "../lib/supabase.js";
import { uploadToStorage, getSignedUrl, BUCKETS } from "../lib/storage.js";

// GET  /api/public-plan?token=xxxx
//   -> { plan, finding, evidence[] } — plan.plan_file_url and each
//      evidence[].file_url are short-lived SIGNED URLs generated fresh on
//      every request; nothing permanent or public is ever stored or returned.
// POST /api/public-plan
//   body: { token, action: 'upload_plan' | 'upload_evidence' | 'submit',
//            uploaded_by, file_name, file_type, file_base64, description, comment }
//
// No system account required — the plan's secure_token (generated when
// Quality approved the finding, see api/observations.js) is the access
// control, scoped to exactly one finding/plan. Files are written straight
// to Supabase Storage; only the bucket+path are persisted in Postgres.

function safeSegment(s) {
  return String(s).replace(/[^a-zA-Z0-9._-]/g, "_");
}

async function attachSignedUrls(plan, evidence) {
  if (plan.plan_storage_path) {
    plan.plan_file_url = await getSignedUrl(plan.plan_storage_bucket || BUCKETS.PLANS, plan.plan_storage_path);
  }
  for (const e of evidence) {
    if (e.storage_path) {
      e.file_url = await getSignedUrl(e.storage_bucket || BUCKETS.EVIDENCE, e.storage_path);
    }
  }
}

export default async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(200).end();

  try {
    if (req.method === "GET") {
      const token = req.query.token;
      if (!token) return res.status(400).json({ success: false, error: "token is required." });

      const plans = await sbGet("improvement_plans", `?secure_token=eq.${encodeURIComponent(token)}`);
      if (!plans.length) return res.status(404).json({ success: false, error: "Plan link not found or expired." });
      const plan = plans[0];

      const findings = await sbGet("findings", `?id=eq.${encodeURIComponent(plan.finding_id)}`);
      const finding = findings[0] || null;
      const evidence = await sbGet("evidence", `?plan_id=eq.${encodeURIComponent(plan.id)}&order=uploaded_at.desc`);

      await attachSignedUrls(plan, evidence);

      return res.status(200).json({ success: true, plan, finding, evidence });
    }

    if (req.method === "POST") {
      const b = req.body || {};
      if (!b.token) return res.status(400).json({ success: false, error: "token is required." });

      const plans = await sbGet("improvement_plans", `?secure_token=eq.${encodeURIComponent(b.token)}`);
      if (!plans.length) return res.status(404).json({ success: false, error: "Plan link not found or expired." });
      const plan = plans[0];

      if (b.action === "upload_plan") {
        if (!b.file_name || !b.file_base64) return res.status(400).json({ success: false, error: "file_name and file_base64 are required." });
        const version = (plan.plan_version || 0) + 1;
        const path = `plan-${plan.id}/v${version}-${safeSegment(b.file_name)}`;
        await uploadToStorage(BUCKETS.PLANS, path, b.file_base64, b.file_type);

        const patch = {
          plan_file_name: b.file_name,
          plan_storage_bucket: BUCKETS.PLANS,
          plan_storage_path: path,
          plan_uploaded_by: b.uploaded_by || "Department",
          plan_uploaded_at: new Date().toISOString(),
          plan_version: version,
          status: "Plan Submitted",
          updated_at: new Date().toISOString(),
        };
        const updated = await sbPatch("improvement_plans", `?id=eq.${encodeURIComponent(plan.id)}`, patch);
        const result = updated[0];
        result.plan_file_url = await getSignedUrl(BUCKETS.PLANS, path);
        await logAudit({ action: "Plan Uploaded", entity_type: "plan", entity_id: plan.id, actor: patch.plan_uploaded_by, new_value: { file_name: b.file_name, version } });
        return res.status(200).json({ success: true, plan: result });
      }

      if (b.action === "upload_evidence") {
        if (!b.file_name || !b.file_base64) return res.status(400).json({ success: false, error: "file_name and file_base64 are required." });
        const path = `plan-${plan.id}/${Date.now()}-${safeSegment(b.file_name)}`;
        await uploadToStorage(BUCKETS.EVIDENCE, path, b.file_base64, b.file_type);

        const evidenceRow = {
          plan_id: plan.id,
          file_name: b.file_name,
          storage_bucket: BUCKETS.EVIDENCE,
          storage_path: path,
          description: b.description || null,
          category: b.category || "Supporting Evidence",
          uploaded_by: b.uploaded_by || "Department",
          verification_status: "Pending",
        };
        const inserted = await sbInsert("evidence", [evidenceRow]);
        const result = inserted[0];
        result.file_url = await getSignedUrl(BUCKETS.EVIDENCE, path);
        await logAudit({ action: "Evidence Uploaded", entity_type: "plan", entity_id: plan.id, actor: evidenceRow.uploaded_by, new_value: { file_name: b.file_name } });
        return res.status(200).json({ success: true, evidence: result });
      }

      if (b.action === "submit") {
        if (!plan.plan_storage_path) {
          return res.status(400).json({ success: false, error: "Upload the completed improvement plan form before submitting." });
        }
        const patch = {
          status: "Plan Submitted",
          plan_comment: b.comment || plan.plan_comment || null,
          updated_at: new Date().toISOString(),
        };
        const updated = await sbPatch("improvement_plans", `?id=eq.${encodeURIComponent(plan.id)}`, patch);
        const result = updated[0];
        result.plan_file_url = await getSignedUrl(BUCKETS.PLANS, result.plan_storage_path);
        await logAudit({ action: "Plan Submitted for QPS Review", entity_type: "plan", entity_id: plan.id, actor: b.uploaded_by || "Department" });
        return res.status(200).json({ success: true, plan: result });
      }

      return res.status(400).json({ success: false, error: "Unknown action." });
    }

    return res.status(405).json({ success: false, error: "Method not allowed" });
  } catch (error) {
    if (handleConfigError(res, error)) return;
    console.error("public-plan API error:", error);
    return res.status(500).json({ success: false, error: error.message || "Internal server error" });
  }
}
