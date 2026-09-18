import { sbGet, sbPatch, logAudit, setCors, handleConfigError } from "../lib/supabase.js";
import { sendWhatsAppNow } from "../lib/twilio-send.js";
import { planReminderMessage } from "../lib/messages.js";
import { getSignedUrl, BUCKETS } from "../lib/storage.js";

// GET   /api/plans                       → list (optionally ?status=...)
// GET   /api/plans?id=123                → single plan + its finding + all
//                                          evidence, each file resolved to a
//                                          short-lived signed URL for the
//                                          "QPS Plan & Evidence Review" screen.
// PATCH /api/plans?id=123
//   body: { action: 'accept' | 'return_revision' | 'request_evidence' |
//                    'verify_implementation' | 'verify_effectiveness' |
//                    'close' | 'reopen',
//            actor, notes?, verification_result?, evidence_reviewed?,
//            effectiveness_confirmed? }
//
// IMPORTANT: uploading a plan never closes a finding by itself (enforced
// in api/public-plan.js, which only ever sets "Plan Submitted"). Only this
// endpoint, driven by an explicit Quality action, can close a finding — and
// 'close' itself is refused unless evidence has been reviewed and effectiveness has been confirmed.

async function notifyResponsible(plan, finding, kind) {
  if (!finding.responsible_member_id) {
    return { success: false, error: "No linked responsible member with a phone number — no WhatsApp sent." };
  }
  const members = await sbGet("round_members", `?id=eq.${encodeURIComponent(finding.responsible_member_id)}`);
  const member = members[0];
  if (!member || !member.mobile) {
    return { success: false, error: "Responsible member has no saved mobile number — no WhatsApp sent." };
  }
  const link = `${plan._baseUrl}/plan/${plan.secure_token}`;
  const message = planReminderMessage({
    lang: member.preferred_language || "ar",
    kind,
    department: finding.department,
    roundId: finding.round_id,
    dueDate: plan.due_date,
    link,
  });
  return sendWhatsAppNow({
    to: member.mobile,
    message,
    roundId: finding.round_id,
    department: finding.department,
    recipientName: member.full_name,
    reminderType: kind,
  });
}

export default async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(200).end();

  try {
    if (req.method === "GET") {
      if (req.query.id) {
        const plans = await sbGet("improvement_plans", `?id=eq.${encodeURIComponent(req.query.id)}`);
        if (!plans.length) return res.status(404).json({ success: false, error: "Plan not found." });
        const plan = plans[0];

        const findings = await sbGet("findings", `?id=eq.${encodeURIComponent(plan.finding_id)}`);
        const finding = findings[0] || null;

        const evidence = await sbGet("evidence", `?plan_id=eq.${encodeURIComponent(plan.id)}&order=uploaded_at.desc`);

        if (plan.plan_storage_path) {
          plan.plan_file_url = await getSignedUrl(plan.plan_storage_bucket || BUCKETS.PLANS, plan.plan_storage_path);
        }
        for (const e of evidence) {
          if (e.storage_path) {
            e.file_url = await getSignedUrl(e.storage_bucket || BUCKETS.EVIDENCE, e.storage_path);
          }
        }

        return res.status(200).json({ success: true, plan, finding, evidence });
      }

      let query = "?order=due_date.asc";
      if (req.query.status) query += `&status=eq.${encodeURIComponent(req.query.status)}`;
      const plans = await sbGet("improvement_plans", query);
      return res.status(200).json({ success: true, plans });
    }

    if (req.method !== "PATCH") return res.status(405).json({ success: false, error: "Method not allowed" });

    const id = req.query.id;
    if (!id) return res.status(400).json({ success: false, error: "id query param is required." });
    const b = req.body || {};
    const action = b.action;

    const plans = await sbGet("improvement_plans", `?id=eq.${encodeURIComponent(id)}`);
    if (!plans.length) return res.status(404).json({ success: false, error: "Plan not found." });
    const plan = plans[0];
    const findings = await sbGet("findings", `?id=eq.${encodeURIComponent(plan.finding_id)}`);
    const finding = findings[0];

    const proto = req.headers["x-forwarded-proto"] || "https";
    const host = req.headers.host || "patient-safety-rounds.vercel.app";
    plan._baseUrl = `${proto}://${host}`;

    if (action === "accept") {
      const updated = await sbPatch("improvement_plans", `?id=eq.${encodeURIComponent(id)}`, { status: "Plan Accepted", updated_at: new Date().toISOString() });
      await logAudit({ action: "Plan Accepted", entity_type: "plan", entity_id: id, actor: b.actor });
      return res.status(200).json({ success: true, plan: updated[0] });
    }

    if (action === "return_revision") {
      const updated = await sbPatch("improvement_plans", `?id=eq.${encodeURIComponent(id)}`, { status: "Plan Revision Required", verification_comments: b.notes || null, updated_at: new Date().toISOString() });
      const wa = await notifyResponsible(Object.assign({}, plan, { status: "Plan Revision Required" }), finding, "revision");
      await logAudit({ action: "Plan Returned for Revision", entity_type: "plan", entity_id: id, actor: b.actor, new_value: { notes: b.notes } });
      return res.status(200).json({ success: true, plan: updated[0], whatsapp: wa });
    }

    if (action === "request_evidence") {
      const updated = await sbPatch("improvement_plans", `?id=eq.${encodeURIComponent(id)}`, { status: "Additional Evidence Required", verification_comments: b.notes || null, updated_at: new Date().toISOString() });
      const wa = await notifyResponsible(plan, finding, "evidence");
      await logAudit({ action: "Additional Evidence Requested", entity_type: "plan", entity_id: id, actor: b.actor, new_value: { notes: b.notes } });
      return res.status(200).json({ success: true, plan: updated[0], whatsapp: wa });
    }

    if (action === "verify_implementation") {
      const updated = await sbPatch("improvement_plans", `?id=eq.${encodeURIComponent(id)}`, { status: "Implementation", updated_at: new Date().toISOString() });
      await logAudit({ action: "Implementation Verified", entity_type: "plan", entity_id: id, actor: b.actor });
      return res.status(200).json({ success: true, plan: updated[0] });
    }

    if (action === "verify_effectiveness") {
      if (!b.verification_result) return res.status(400).json({ success: false, error: "verification_result is required." });
      const patch = {
        verified_by: b.actor || "Quality Reviewer",
        verification_date: new Date().toISOString().slice(0, 10),
        verification_result: b.verification_result,
        verification_comments: b.notes || null,
        evidence_reviewed: !!b.evidence_reviewed,
        effectiveness_confirmed: !!b.effectiveness_confirmed,
        updated_at: new Date().toISOString(),
      };
      if (["Not Effective", "Requires Further Action"].includes(b.verification_result)) {
        patch.status = "Plan Revision Required";
        const updated = await sbPatch("improvement_plans", `?id=eq.${encodeURIComponent(id)}`, patch);
        const wa = await notifyResponsible(Object.assign({}, plan, patch), finding, "revision");
        await logAudit({ action: "Effectiveness Verification — Further Action Required", entity_type: "plan", entity_id: id, actor: patch.verified_by, new_value: patch });
        return res.status(200).json({ success: true, plan: updated[0], whatsapp: wa, reopened: true });
      }
      patch.status = "Under Verification";
      const updated = await sbPatch("improvement_plans", `?id=eq.${encodeURIComponent(id)}`, patch);
      await logAudit({ action: "Effectiveness Verified", entity_type: "plan", entity_id: id, actor: patch.verified_by, new_value: patch });
      return res.status(200).json({ success: true, plan: updated[0] });
    }

    if (action === "close") {
      const missing = [];
      if (!plan.evidence_reviewed) missing.push("Evidence has not been marked as reviewed.");
      if (!plan.effectiveness_confirmed) missing.push("Effectiveness has not been confirmed.");
      if (!["Effective", "Partially Effective"].includes(plan.verification_result)) missing.push("Effectiveness verification result must be Effective or Partially Effective.");
      if (missing.length) {
        return res.status(400).json({ success: false, error: "Cannot close finding.", reasons: missing });
      }
      const patch = { status: "Closed", closure_date: new Date().toISOString().slice(0, 10), updated_at: new Date().toISOString() };
      const updated = await sbPatch("improvement_plans", `?id=eq.${encodeURIComponent(id)}`, patch);
      await sbPatch("findings", `?id=eq.${encodeURIComponent(plan.finding_id)}`, { status: "Closed", updated_at: new Date().toISOString() });
      await logAudit({ action: "Finding Closed", entity_type: "plan", entity_id: id, actor: b.actor, new_value: patch });
      return res.status(200).json({ success: true, plan: updated[0] });
    }

    if (action === "reopen") {
      if (!b.notes) return res.status(400).json({ success: false, error: "A reason is required to reopen." });
      const patch = { status: "Reopened", closure_date: null, verification_comments: b.notes, updated_at: new Date().toISOString() };
      const updated = await sbPatch("improvement_plans", `?id=eq.${encodeURIComponent(id)}`, patch);
      await sbPatch("findings", `?id=eq.${encodeURIComponent(plan.finding_id)}`, { status: "Reopened", updated_at: new Date().toISOString() });
      await logAudit({ action: "Finding Reopened", entity_type: "plan", entity_id: id, actor: b.actor, new_value: { reason: b.notes } });
      return res.status(200).json({ success: true, plan: updated[0] });
    }

    return res.status(400).json({ success: false, error: "Unknown action." });
  } catch (error) {
    if (handleConfigError(res, error)) return;
    console.error("plans API error:", error);
    return res.status(500).json({ success: false, error: error.message || "Internal server error" });
  }
}
