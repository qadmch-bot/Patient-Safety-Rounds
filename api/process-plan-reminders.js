import { sbGet, sbPatch } from "../lib/supabase.js";
import { sendWhatsAppNow } from "../lib/twilio-send.js";
import { planReminderMessage } from "../lib/messages.js";

// Runs daily (see vercel.json cron). For every open corrective plan (not yet
// submitted/closed), sends a real WhatsApp reminder if none has gone out
// today for that plan: "before due" (3 days out), "due today", or "overdue".
// Never marks a reminder sent unless Twilio actually accepted it — see
// lib/twilio-send.js, which logs the true per-message result either way.

const OPEN_STATUSES = ["Plan Requested", "Plan Revision Required", "Additional Evidence Required"];

export default async function handler(req, res) {
  if (!["GET", "POST"].includes(req.method)) {
    return res.status(405).json({ success: false, error: "Method not allowed" });
  }

  try {
    const today = new Date().toISOString().slice(0, 10);
    const results = [];

    for (const status of OPEN_STATUSES) {
      const plans = await sbGet("improvement_plans", `?status=eq.${encodeURIComponent(status)}&order=due_date.asc&limit=50`);

      for (const plan of plans) {
        if (plan.last_reminder_sent_at && plan.last_reminder_sent_at.slice(0, 10) === today) continue;

        const daysLeft = Math.round((new Date(plan.due_date) - new Date(today)) / 86400000);
        let kind = null;
        if (daysLeft === 3) kind = "before_due";
        else if (daysLeft === 0) kind = "due_today";
        else if (daysLeft < 0) kind = "overdue";
        if (!kind) continue;

        const findings = await sbGet("findings", `?id=eq.${encodeURIComponent(plan.finding_id)}`);
        const finding = findings[0];
        if (!finding || !finding.responsible_member_id) { results.push({ plan: plan.id, sent: false, reason: "no linked responsible member" }); continue; }

        const members = await sbGet("round_members", `?id=eq.${encodeURIComponent(finding.responsible_member_id)}`);
        const member = members[0];
        if (!member || !member.mobile) { results.push({ plan: plan.id, sent: false, reason: "no mobile number" }); continue; }

        const proto = req.headers["x-forwarded-proto"] || "https";
        const host = req.headers.host || "patient-safety-rounds.vercel.app";
        const link = `${proto}://${host}/plan/${plan.secure_token}`;

        const message = planReminderMessage({
          lang: member.preferred_language || "ar",
          kind,
          department: finding.department,
          roundId: finding.round_id,
          dueDate: plan.due_date,
          link,
        });

        const sendResult = await sendWhatsAppNow({
          to: member.mobile,
          message,
          roundId: finding.round_id,
          department: finding.department,
          recipientName: member.full_name,
          reminderType: kind,
        });

        await sbPatch("improvement_plans", `?id=eq.${encodeURIComponent(plan.id)}`, {
          last_reminder_type: kind,
          last_reminder_sent_at: new Date().toISOString(),
        }, "minimal").catch(() => {});

        results.push({ plan: plan.id, kind, sent: sendResult.success, error: sendResult.error });
      }
    }

    return res.status(200).json({ success: true, processed: results.length, results });
  } catch (error) {
    console.error("process-plan-reminders error:", error);
    return res.status(500).json({ success: false, error: error.message || "Internal server error" });
  }
}
