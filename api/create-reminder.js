import { sbGet, sbUpsert, logAudit, setCors, handleConfigError } from "../lib/supabase.js";

// POST /api/create-reminder
// Body: { round_id: "PSR-2026-013" }
//
// Reads the round + its linked members from Supabase, and creates (or
// re-creates, if the round was rescheduled) the 24-hour and 1-hour
// WhatsApp reminder rows in whatsapp_reminders. The existing cron job
// (/api/process-reminders, already running every 5 minutes per
// vercel.json) picks these up and sends them via Twilio — this endpoint
// does not send anything itself, it only queues real work for it.
//
// Duplicate prevention: event_key = round_id + '|' + member_id + '|' + type,
// enforced by a unique index in Supabase (see sql/001_init_schema.sql).
// Re-calling this endpoint for the same round is therefore safe.

function buildMessage(round, member, kind) {
  const isAr = (member.preferred_language || "ar") === "ar";
  const depts = Array.isArray(round.departments) ? round.departments.join(" + ") : round.departments;
  const link = round._link || "";
  const kindLabelAr = kind === "24h" ? "قبل 24 ساعة" : "قبل ساعة واحدة";
  const kindLabelEn = kind === "24h" ? "24 hours before" : "1 hour before";

  if (isAr) {
    return `🔔 تذكير بجولة سلامة المرضى (${kindLabelAr})

رقم الجولة: ${round.id}
القسم: ${depts}
التاريخ: ${round.planned_date}
الوقت: ${round.planned_time}

يرجى الاستعداد للجولة ومراجعة البنود المتعلقة بمجالكم.

للدخول إلى الجولة وتسجيل الملاحظات:
${link}

إدارة الجودة وسلامة المرضى
مستشفى الولادة والأطفال – حفر الباطن`;
  }
  return `🔔 Patient Safety Round Reminder (${kindLabelEn})

Round ID: ${round.id}
Department(s): ${depts}
Date: ${round.planned_date}
Time: ${round.planned_time}

Please prepare for the round and review the items relevant to your area.

To open the round and record observations:
${link}

Quality & Patient Safety Management
Maternity & Children Hospital – Hafr Al Batin`;
}

function minutesBefore(dateStr, timeStr, minutes) {
  // Round times are entered in Saudi Arabia local time (UTC+03:00).
  const time = String(timeStr || "").slice(0, 5);
  const dt = new Date(`${dateStr}T${time}:00+03:00`);
  if (!Number.isFinite(dt.getTime())) throw new Error("Invalid round date/time");
  return new Date(dt.getTime() - minutes * 60000).toISOString();
}

export default async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ success: false, error: "Method not allowed" });

  try {
    const { round_id } = req.body || {};
    if (!round_id) return res.status(400).json({ success: false, error: "round_id is required." });

    const roundRows = await sbGet("rounds", `?id=eq.${encodeURIComponent(round_id)}`);
    if (!roundRows.length) return res.status(404).json({ success: false, error: "Round not found." });
    const round = roundRows[0];

    if (round.status !== "Scheduled" || !round.secure_token) return res.status(400).json({success:false,error:"Only scheduled rounds with a public token may be queued."});
    const baseUrl = (process.env.PUBLIC_BASE_URL || "https://patient-safety-rounds.vercel.app").replace(/\/$/, "");
    round._link = `${baseUrl}/round/${round.secure_token}`;
    const roundStart = Date.parse(`${round.planned_date}T${String(round.planned_time).slice(0,5)}:00+03:00`);
    if (!Number.isFinite(roundStart) || roundStart <= Date.now()) return res.status(400).json({success:false,error:"Past or invalid rounds cannot be queued."});

    const participants = await sbGet(
      "round_participants",
      `?round_id=eq.${encodeURIComponent(round_id)}&select=round_members(id,full_name,mobile,whatsapp_enabled,active,preferred_language)`
    );
    const members = participants
      .map((p) => p.round_members)
      .filter((m) => m && m.active && m.whatsapp_enabled && m.mobile);

    if (!members.length) {
      return res.status(200).json({
        success: true,
        created: 0,
        message: "No WhatsApp-enabled, active members with a saved mobile number are linked to this round.",
      });
    }

    const rows = [];
    members.forEach((m) => {
      [
        { type: "24h", minutes: 24 * 60 },
        { type: "1h", minutes: 60 },
      ].forEach(({ type, minutes }) => {
        const scheduledAt = minutesBefore(round.planned_date, round.planned_time, minutes);
        if (Date.parse(scheduledAt) <= Date.now()) return;
        rows.push({
          round_id: round.id,
          department: Array.isArray(round.departments) ? round.departments.join(" + ") : round.departments,
          recipient_name: m.full_name,
          recipient_phone: m.mobile,
          reminder_type: type,
          message: buildMessage(round, m, type),
          event_key: `${round.id}|${m.id}|${type}`,
          status: "pending",
          scheduled_at: scheduledAt,
        });
      });
    });

    const inserted = await sbUpsert("whatsapp_reminders", rows, "event_key");

    await logAudit({
      action: "Reminders Created",
      entity_type: "round",
      entity_id: round.id,
      new_value: { count: inserted.length, members: members.map((m) => m.full_name) },
    });

    return res.status(200).json({ success: true, created: inserted.length, reminders: inserted });
  } catch (error) {
    if (handleConfigError(res, error)) return;
    console.error("create-reminder API error:", error);
    return res.status(500).json({ success: false, error: error.message || "Internal server error" });
  }
}
