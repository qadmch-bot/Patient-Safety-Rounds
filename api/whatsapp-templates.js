import { sbGet, sbPatch, logAudit, setCors, handleConfigError } from "../lib/supabase.js";

// GET   /api/whatsapp-templates              → list all templates + status
// PATCH /api/whatsapp-templates?name=xxx      → update status (Approved/Pending/Rejected)
//
// HONESTY NOTE: this system cannot ask Meta/Twilio "is this template really
// approved?" without a separate Twilio Content API integration, which is
// not built here. Quality marks a template Approved once they've confirmed
// it in the Twilio console — api/whatsapp-manual-send.js then refuses to
// send against anything not marked Approved. This is a manual safety gate,
// not a live sync with Meta.

export default async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(200).end();

  try {
    if (req.method === "GET") {
      const templates = await sbGet("whatsapp_templates", "?order=name.asc");
      return res.status(200).json({ success: true, templates });
    }

    if (req.method === "PATCH") {
      const name = req.query.name;
      if (!name) return res.status(400).json({ success: false, error: "name query param is required." });
      const b = req.body || {};
      if (!["Approved", "Pending", "Rejected"].includes(b.status)) {
        return res.status(400).json({ success: false, error: "status must be Approved, Pending or Rejected." });
      }
      const updated = await sbPatch("whatsapp_templates", `?name=eq.${encodeURIComponent(name)}`, { status: b.status, updated_at: new Date().toISOString() });
      await logAudit({ action: "WhatsApp Template Status Changed", entity_type: "whatsapp_template", entity_id: name, actor: b.actor, new_value: { status: b.status } });
      return res.status(200).json({ success: true, template: updated[0] });
    }

    return res.status(405).json({ success: false, error: "Method not allowed" });
  } catch (error) {
    if (handleConfigError(res, error)) return;
    console.error("whatsapp-templates API error:", error);
    return res.status(500).json({ success: false, error: error.message || "Internal server error" });
  }
}
