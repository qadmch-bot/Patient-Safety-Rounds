import { sbGet, sbPatch } from "../lib/supabase.js";
import { sendTwilioMessageRaw, sendWhatsAppNow } from "../lib/twilio-send.js";
import { planReminderMessage } from "../lib/messages.js";

// Single endpoint merging the previous process-reminders.js (automatic
// 24h/1h round reminders) and process-plan-reminders.js (corrective-plan
// due/overdue reminders) — required to stay within Vercel Hobby's 12
// Serverless Function limit. Dispatched via ?type=round (default) or
// ?type=plan — see vercel.json, which now points two separate cron
// schedules at this one file with different query strings.
//
// NOTE ON THE ROUND-REMINDER HALF: this reconstructs the round-reminder
// processing logic against the same whatsapp_reminders schema and the
// same Twilio call path already proven elsewhere in this codebase
// (lib/twilio-send.js) — it is not a byte-for-byte copy of whatever was
// previously deployed, since that source was no longer available to
// copy from. Functionally it does exactly what's required: pick up
// pending, due reminders and send them via Twilio, marking sent/failed.
// Please smoke-test the 24h/1h path once after deploying.

export default async function handler(req, res) {
  const type = req.query.type === "plan" ? "plan" : "round";
  if (type === "plan") return processPlanReminders(req, res);
  return processRoundReminders(req, res);
}

// ---------------------------------------------------------------------
// type=round (default) — 24-hour / 1-hour Patient Safety Round reminders.
// Picks up rows in whatsapp_reminders that are still "pending" and whose
// scheduled_at has arrived (created by api/create-reminder.js when a
// round is scheduled), sends each via Twilio, and marks the real result.
// ---------------------------------------------------------------------
async function processRoundReminders(req, res) {
  if (!["GET", "POST"].includes(req.method)) {
    return res.status(405).json({ success: false, error: "Method not allowed" });
  }
  try {
    const nowIso = new Date().toISOString();
    const dueRows = await sbGet(
      "whatsapp_reminders",
      `?status=eq.pending&scheduled_at=lte.${encodeURIComponent(nowIso)}&order=scheduled_at.asc&limit=50`
    );

    const results = [];
    for (const row of dueRows) {
      // Optimistic lock so two overlapping cron invocations can't double-send.
      const locked = await sbPatch(
        "whatsapp_reminders",
        `?id=eq.${row.id}&status=eq.pending`,
        { status: "processing", processing_at: new Date().toISOString() }
      );
      if (!locked.length) continue;

      const sendResult = await sendTwilioMessageRaw({ to: row.recipient_phone, message: row.message });

      if (sendResult.success) {
        await sbPatch("whatsapp_reminders", `?id=eq.${row.id}`, {
          status: "sent",
          sent_at: new Date().toISOString(),
          twilio_message_sid: sendResult.sid,
          attempts: (row.attempts || 0) + 1,
          updated_at: new Date().toISOString(),
        }, "minimal").catch(() => {});
      } else {
        await sbPatch("whatsapp_reminders", `?id=eq.${row.id}`, {
          status: "failed",
          error_message: sendResult.error,
          attempts: (row.attempts || 0) + 1,
          updated_at: new Date().toISOString(),
        }, "minimal").catch(() => {});
      }
      results.push({ id: row.id, round_id: row.round_id, reminder_type: row.reminder_type, sent: sendResult.success, error: sendResult.error });
    }

    return res.status(200).json({ success: true, processed: results.length, results });
  } catch (error) {
    console.error("process-reminders (round) error:", error);
    return res.status(500).json({ success: false, error: error.message || "Internal server error" });
  }
}

// ---------------------------------------------------------------------
// type=plan — corrective-plan due/overdue reminders.
// Identical logic to the previous api/process-plan-reminders.js.
// ---------------------------------------------------------------------
const OPEN_STATUSES = ["Plan Requested", "Plan Revision Required", "Additional Evidence Required"];

async function processPlanReminders(req, res) {
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
    console.error("process-reminders (plan) error:", error);
    return res.status(500).json({ success: false, error: error.message || "Internal server error" });
  }
}
