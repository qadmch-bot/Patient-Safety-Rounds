import { sbGet, sbInsert, setCors, handleConfigError } from "../lib/supabase.js";
import { sendTwilioMessageRaw } from "../lib/twilio-send.js";
import { manualRoundMessage } from "../lib/messages.js";
import { normalizeToE164 } from "../lib/phone.js";

// GET  /api/whatsapp-manual-send?round_id=&recipient=&status=&date=
//   -> history list, most recent first, with optional filters.
// POST /api/whatsapp-manual-send
//   body: { round_id, recipients: [{ name, mobile }], language, template_name, sent_by }
//   -> sends ONE real Twilio WhatsApp message per recipient immediately.
//      Does not touch the automatic reminder schedule/queue at all — this
//      is a fully separate, admin-triggered production action.
//
// Template gating: refuses to send if the named template's status (see
// api/whatsapp-templates.js) is not "Approved".

export default async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(200).end();

  try {
    if (req.method === "GET") {
      let query = "?order=created_at.desc&limit=200";
      if (req.query.round_id) query += `&round_id=eq.${encodeURIComponent(req.query.round_id)}`;
      if (req.query.status) query += `&status=eq.${encodeURIComponent(req.query.status)}`;
      if (req.query.recipient) query += `&recipient_mobile=ilike.*${encodeURIComponent(req.query.recipient)}*`;
      if (req.query.date) query += `&created_at=gte.${encodeURIComponent(req.query.date)}`;
      const rows = await sbGet("whatsapp_manual_messages", query);
      return res.status(200).json({ success: true, messages: rows });
    }

    if (req.method !== "POST") return res.status(405).json({ success: false, error: "Method not allowed" });

    const b = req.body || {};
    if (!b.round_id) return res.status(400).json({ success: false, error: "round_id is required." });
    if (!Array.isArray(b.recipients) || !b.recipients.length) {
      return res.status(400).json({ success: false, error: "At least one recipient is required." });
    }
    if (!b.template_name) return res.status(400).json({ success: false, error: "template_name is required." });

    const templates = await sbGet("whatsapp_templates", `?name=eq.${encodeURIComponent(b.template_name)}`);
    const template = templates[0];
    if (!template) return res.status(400).json({ success: false, error: "Unknown template." });
    if (template.status !== "Approved") {
      return res.status(400).json({
        success: false,
        error: `Cannot send — template "${b.template_name}" is not Approved (current status: ${template.status}). Business-initiated WhatsApp messages require an approved template.`,
      });
    }

    const rounds = await sbGet("rounds", `?id=eq.${encodeURIComponent(b.round_id)}`);
    if (!rounds.length) return res.status(404).json({ success: false, error: "Round not found." });
    const round = rounds[0];

    const proto = req.headers["x-forwarded-proto"] || "https";
    const host = req.headers.host || "patient-safety-rounds.vercel.app";
    const link = `${proto}://${host}/round/${round.secure_token}`;
    const lang = b.language === "en" ? "en" : "ar";
    const message = manualRoundMessage({ lang, round, link });

    const results = [];
    for (const recipient of b.recipients) {
      const mobile = normalizeToE164(recipient.mobile);
      const row = {
        round_id: b.round_id,
        recipient_name: recipient.name || null,
        recipient_mobile: recipient.mobile || "",
        language: lang,
        template_name: b.template_name,
        sent_by: b.sent_by || "Quality Admin",
        status: "pending",
      };

      if (!mobile) {
        row.status = "failed";
        row.failure_reason = "Invalid mobile number format.";
        const inserted = await sbInsert("whatsapp_manual_messages", [row]);
        results.push(inserted[0]);
        continue;
      }
      row.recipient_mobile = mobile;

      const sendResult = await sendTwilioMessageRaw({ to: mobile, message });
      if (sendResult.success) {
        row.status = "sent";
        row.message_sid = sendResult.sid;
        row.sent_at = new Date().toISOString();
      } else {
        row.status = "failed";
        row.failure_reason = sendResult.error;
      }
      const inserted = await sbInsert("whatsapp_manual_messages", [row]);
      results.push(inserted[0]);
    }

    const anySuccess = results.some((r) => r.status === "sent");
    return res.status(200).json({ success: anySuccess, results, message_preview: message });
  } catch (error) {
    if (handleConfigError(res, error)) return;
    console.error("whatsapp-manual-send API error:", error);
    return res.status(500).json({ success: false, error: error.message || "Internal server error" });
  }
}
