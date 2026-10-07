import { sbGet, sbInsert, sbPatch, logAudit, setCors, handleConfigError } from "../lib/supabase.js";
import { computePlanDates } from "../lib/planDates.js";
import { sendWhatsAppNow } from "../lib/twilio-send.js";
import { planRequestMessage } from "../lib/messages.js";

function randomToken() {
  return [...crypto.getRandomValues(new Uint8Array(24))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// GET   /api/observations                → list (optionally ?status=... , ?department=...)
// PATCH /api/observations?id=123          → QPS decision
//   body: { decision: 'approve'|'reject'|'clarify'|'edit'|'reopen'|'delete',
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
      if (!["approve", "reject", "clarify", "edit", "reopen", "delete"].includes(decision)) {
        return res.status(400).json({ success: false, error: "Invalid observation decision." });
      }

      const rows = await sbGet("observations", `?id=eq.${encodeURIComponent(id)}`);
      if (!rows.length) return res.status(404).json({ success: false, error: "Observation not found." });
      const obs = rows[0];

      if (decision === "reopen" || decision === "delete") {
        const linkedFindings = await sbGet("findings", `?observation_id=eq.${encodeURIComponent(obs.id)}`);
        const targetStatus = decision === "delete" ? "Deleted" : "Submitted for QPS Review";
        const patch = {
          status: targetStatus,
          qps_reviewer: b.qps_reviewer || "Quality Reviewer",
          qps_decision_notes: decision === "delete" ? "Deleted by QPS after review" : "Reopened by QPS for correction/review",
          qps_decision_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        };
        const updated = await sbPatch("observations", `?id=eq.${encodeURIComponent(id)}`, patch);
        for (const finding of linkedFindings) {
          await sbPatch("findings", `?id=eq.${encodeURIComponent(finding.id)}`, { status: decision === "delete" ? "Deleted" : "Reopened" });
        }
        await logAudit({ action: decision === "delete" ? "Observation Deleted" : "Observation Reopened", entity_type: "observation", entity_id: id, actor: patch.qps_reviewer, previous_value: obs, new_value: patch });
        return res.status(200).json({ success: true, observation: updated[0], linked_findings: linkedFindings.length });
      }

      if (decision === "edit") {
        const patch = {
          updated_at: new Date().toISOString(),
          status: "Submitted for QPS Review",
          qps_reviewer: b.qps_reviewer || "Quality Reviewer",
          qps_decision_notes: "Edited by QPS and returned for review",
          qps_decision_at: new Date().toISOString(),
        };
        if (b.edited_text) patch.observation_text = b.edited_text;
        if (b.domain) patch.domain = b.domain;
        if (b.checklist_item) patch.checklist_item = b.checklist_item;
        const linkedFindings = await sbGet("findings", `?observation_id=eq.${encodeURIComponent(obs.id)}`);
        const updated = await sbPatch("observations", `?id=eq.${encodeURIComponent(id)}`, patch);
        for (const finding of linkedFindings) {
          await sbPatch("findings", `?id=eq.${encodeURIComponent(finding.id)}`, {
            status: "Reopened",
            domain: patch.domain || obs.domain,
            checklist_item: patch.checklist_item || obs.checklist_item,
            observation_text: patch.observation_text || obs.observation_text,
          });
        }
        await logAudit({ action: "Observation Edited and Reopened", entity_type: "observation", entity_id: id, actor: patch.qps_reviewer, previous_value: obs, new_value: patch });
        return res.status(200).json({ success: true, observation: updated[0], linked_findings: linkedFindings.length });
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
      // Idempotency guard: a double click / repeated network request must not
      // create a second finding, second plan, or second WhatsApp message.
      const existingFindings = await sbGet("findings", `?observation_id=eq.${encodeURIComponent(obs.id)}&order=id.asc&limit=1`);
      if (existingFindings.length) {
        const existingFinding = existingFindings[0];
        const existingPlans = await sbGet("improvement_plans", `?finding_id=eq.${encodeURIComponent(existingFinding.id)}&order=id.asc&limit=1`);
        if (["Reopened", "Deleted"].includes(existingFinding.status) || obs.status !== "Approved") {
          const restoredObsPatch = {
            status: "Approved", qps_reviewer: b.qps_reviewer || "Quality Reviewer", qps_decision_notes: b.notes || null,
            qps_decision_at: new Date().toISOString(), risk_level: b.risk_level || obs.risk_level || existingFinding.risk_level,
            responsible_department: b.responsible_department || obs.responsible_department || existingFinding.department || obs.department,
            responsible_person: b.responsible_person || obs.responsible_person || existingFinding.responsible_person || null,
            corrective_required: b.corrective_required ?? obs.corrective_required ?? existingFinding.corrective_required, updated_at: new Date().toISOString()
          };
          const restoredObs = await sbPatch("observations", `?id=eq.${encodeURIComponent(id)}`, restoredObsPatch);
          const restoredFinding = await sbPatch("findings", `?id=eq.${encodeURIComponent(existingFinding.id)}`, {
            status:"Approved", risk_level:restoredObsPatch.risk_level, responsible_department:restoredObsPatch.responsible_department, department:restoredObsPatch.responsible_department, responsible_person:restoredObsPatch.responsible_person
          });
          await logAudit({ action:"Observation Re-approved", entity_type:"observation", entity_id:id, actor:restoredObsPatch.qps_reviewer, previous_value:obs, new_value:restoredObsPatch });
          return res.status(200).json({ success:true, observation:restoredObs[0], finding:restoredFinding[0], plan:existingPlans[0]||null, whatsapp:{success:true,skipped:true,reason:"Existing finding restored; duplicate notification prevented."}, recurring:!!existingFinding.is_recurring });
        }
        return res.status(200).json({
          success: true, duplicate_prevented: true, observation: obs, finding: existingFinding, plan: existingPlans[0] || null,
          whatsapp: { success: true, skipped: true, reason: "Already approved; duplicate notification prevented." }, recurring: !!existingFinding.is_recurring
        });
      }
      if (b.corrective_required && (!/^\d{4}-\d{2}-\d{2}$/.test(b.due_date || "") || b.due_date < new Date().toISOString().slice(0,10))) return res.status(400).json({success:false,error:"A valid due_date is required before approving a corrective plan."});
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
          due_date: b.due_date,
          due_date_is_manual: true,
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
            const link = `${(process.env.PUBLIC_BASE_URL || "https://patient-safety-rounds.vercel.app").replace(/\/$/, "")}/plan/${plan.secure_token}`;
            const message = planRequestMessage({
              lang: member.preferred_language || "ar",
              department: patch.responsible_department,
              roundId: obs.round_id,
              findingSummary: obs.observation_text,
              startDate,
              dueDate: b.due_date,
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
