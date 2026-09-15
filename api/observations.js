import { sbGet, sbInsert, sbPatch, logAudit, setCors, handleConfigError } from "../lib/supabase.js";
import { computePlanDates } from "../lib/planDates.js";
import { sendWhatsAppNow } from "../lib/twilio-send.js";
import { planRequestMessage } from "../lib/messages.js";

function randomToken() {
  return [...crypto.getRandomValues(new Uint8Array(24))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// GET   /api/observations                → list (optionally ?status=... , ?department=...)
// PATCH /api/observations?id=123          → QPS decision
//   body: { decision: 'approve'|'reject'|'clarify'|'edit',
//            edited_text?, qps_reviewer, notes?,
//            risk_level?, responsible_department?, responsible_person?,
//            responsible_member_id?, corrective_required? }

export default async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(200).end();

  try {
    if (req.method === "GET") {
      let query = "?order=submitted_at.desc";
      if (req.query.status) query += `&status=eq.${encodeURIComponent(req.query.status)}`;
      if (req.query.department) query += `&department=eq.${encodeURIComponent(req.query.department)}`;
      const rows = await sbGet("observations", query);
      return res.status(200).json({ success: true, observations: rows });
    }

    if (req.method === "PATCH") {
      const id = req.query.id;
      if (!id) return res.status(400).json({ success: false, error: "id query param is required." });
      const b = req.body || {};
      const decision = b.decision;
      if (!["approve", "reject", "clarify", "edit"].includes(decision)) {
        return res.status(400).json({ success: false, error: "decision must be approve, reject, clarify or edit." });
      }

      const rows = await sbGet("observations", `?id=eq.${encodeURIComponent(id)}`);
      if (!rows.length) return res.status(404).json({ success: false, error: "Observation not found." });
      const obs = rows[0];

      if (decision === "edit") {
        const patch = { updated_at: new Date().toISOString() };
        if (b.edited_text) patch.observation_text = b.edited_text;
        const updated = await sbPatch("observations", `?id=eq.${encodeURIComponent(id)}`, patch);
        await logAudit({ action: "Observation Edited", entity_type: "observation", entity_id: id, actor: b.qps_reviewer, new_value: patch });
        return res.status(200).json({ success: true, observation: updated[0] });
      }

      if (decision === "reject" || decision === "clarify") {
        const patch = {
          status: decision === "reject" ? "Rejected" : "Clarification Requested",
          qps_reviewer: b.qps_reviewer || "Quality Reviewer",
          qps_decision_notes: b.notes || null,
          qps_decision_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        };
        const updated = await sbPatch("observations", `?id=eq.${encodeURIComponent(id)}`, patch);
        await logAudit({ action: `Observation ${patch.status}`, entity_type: "observation", entity_id: id, actor: patch.qps_reviewer, new_value: patch });
        return res.status(200).json({ success: true, observation: updated[0] });
      }

      // decision === 'approve'
      if (!b.risk_level) return res.status(400).json({ success: false, error: "risk_level is required to approve." });
      const patch = {
        status: "Approved",
        qps_reviewer: b.qps_reviewer || "Quality Reviewer",
        qps_decision_notes: b.notes || null,
        qps_decision_at: new Date().toISOString(),
        risk_level: b.risk_level,
        responsible_department: b.responsible_department || obs.department,
        responsible_person: b.responsible_person || null,
        corrective_required: !!b.corrective_required,
        updated_at: new Date().toISOString(),
      };
      const updatedObs = await sbPatch("observations", `?id=eq.${encodeURIComponent(id)}`, patch);

      // Recurrence check: same department + domain + checklist_item approved before.
      const priorMatches = await sbGet(
        "findings",
        `?department=eq.${encodeURIComponent(patch.responsible_department)}&domain=eq.${encodeURIComponent(obs.domain)}&checklist_item=eq.${encodeURIComponent(obs.checklist_item)}`
      );
      const isRecurring = priorMatches.length > 0;

      const findingRow = {
        observation_id: obs.id,
        round_id: obs.round_id,
        department: patch.responsible_department,
        domain: obs.domain,
        checklist_item: obs.checklist_item,
        risk_level: b.risk_level,
        responsible_department: patch.responsible_department,
        responsible_person: patch.responsible_person,
        responsible_member_id: b.responsible_member_id || null,
        corrective_required: !!b.corrective_required,
        is_recurring: isRecurring,
        status: "Approved",
      };
      const insertedFinding = await sbInsert("findings", [findingRow]);
      const finding = insertedFinding[0];
      await logAudit({ action: "Finding Created", entity_type: "finding", entity_id: finding.id, actor: patch.qps_reviewer, new_value: findingRow });

      let plan = null;
      let whatsappResult = null;
      if (b.corrective_required) {
        const rounds = await sbGet("rounds", `?id=eq.${encodeURIComponent(obs.round_id)}`);
        const round = rounds[0];
        const { startDate, dueDate } = await computePlanDates(round.planned_date, patch.responsible_department);

        const planRow = {
          finding_id: finding.id,
          start_date: startDate,
          due_date: dueDate,
          status: "Plan Requested",
          secure_token: randomToken(),
        };
        const insertedPlan = await sbInsert("improvement_plans", [planRow]);
        plan = insertedPlan[0];
        await logAudit({ action: "Corrective Plan Requested", entity_type: "plan", entity_id: plan.id, actor: patch.qps_reviewer, new_value: planRow });

        if (b.responsible_member_id) {
          const members = await sbGet("round_members", `?id=eq.${encodeURIComponent(b.responsible_member_id)}`);
          const member = members[0];
          if (member && member.mobile) {
            const proto = req.headers["x-forwarded-proto"] || "https";
            const host = req.headers.host || "patient-safety-rounds.vercel.app";
            const link = `${proto}://${host}/plan/${plan.secure_token}`;
            const message = planRequestMessage({
              lang: member.preferred_language || "ar",
              department: patch.responsible_department,
              roundId: obs.round_id,
              findingSummary: obs.observation_text,
              startDate,
              dueDate,
              link,
            });
            whatsappResult = await sendWhatsAppNow({
              to: member.mobile,
              message,
              roundId: obs.round_id,
              department: patch.responsible_department,
              recipientName: member.full_name,
              reminderType: "plan_request",
            });
          } else {
            whatsappResult = { success: false, error: "No responsible member with a saved mobile number was specified — no WhatsApp sent." };
          }
        } else {
          whatsappResult = { success: false, error: "No responsible_member_id specified — no WhatsApp sent." };
        }
      }

      return res.status(200).json({ success: true, observation: updatedObs[0], finding, plan, whatsapp: whatsappResult, recurring: isRecurring });
    }

    return res.status(405).json({ success: false, error: "Method not allowed" });
  } catch (error) {
    if (handleConfigError(res, error)) return;
    console.error("observations API error:", error);
    return res.status(500).json({ success: false, error: error.message || "Internal server error" });
  }
}
