import { sbGet, sbInsert, sbPatch, sbDelete, logAudit, setCors, handleConfigError } from "../lib/supabase.js";

// GET    /api/round-members                → list all members (active + inactive)
// POST   /api/round-members                → create a member
// PATCH  /api/round-members?id=123          → update a member
// DELETE /api/round-members?id=123          → delete a member
//
// Body shape (POST/PATCH):
// { full_name, job_title, department, mobile, preferred_language, whatsapp_enabled, active }

export default async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(200).end();

  try {
    if (req.method === "GET") {
      const rows = await sbGet("round_members", "?order=full_name.asc");
      return res.status(200).json({ success: true, members: rows });
    }

    if (req.method === "POST") {
      const b = req.body || {};
      if (!b.full_name) {
        return res.status(400).json({ success: false, error: "full_name is required." });
      }
      const row = {
        full_name: b.full_name,
        job_title: b.job_title || null,
        department: b.department || "ALL",
        mobile: b.mobile || null,
        preferred_language: b.preferred_language || "ar",
        whatsapp_enabled: !!b.whatsapp_enabled,
        active: b.active !== false,
      };
      const inserted = await sbInsert("round_members", [row]);
      await logAudit({ action: "Member Created", entity_type: "member", entity_id: inserted[0]?.id, actor: b.actor, new_value: row });
      return res.status(200).json({ success: true, member: inserted[0] });
    }

    if (req.method === "PATCH") {
      const id = req.query.id;
      if (!id) return res.status(400).json({ success: false, error: "id query param is required." });
      const b = req.body || {};
      const patch = {};
      ["full_name", "job_title", "department", "mobile", "preferred_language", "whatsapp_enabled", "active"].forEach((k) => {
        if (b[k] !== undefined) patch[k] = b[k];
      });
      patch.updated_at = new Date().toISOString();
      const updated = await sbPatch("round_members", `?id=eq.${id}`, patch);
      await logAudit({ action: "Member Updated", entity_type: "member", entity_id: id, actor: b.actor, new_value: patch });
      return res.status(200).json({ success: true, member: updated[0] });
    }

    if (req.method === "DELETE") {
      const id = req.query.id;
      if (!id) return res.status(400).json({ success: false, error: "id query param is required." });
      await sbDelete("round_members", `?id=eq.${id}`);
      await logAudit({ action: "Member Deleted", entity_type: "member", entity_id: id });
      return res.status(200).json({ success: true });
    }

    return res.status(405).json({ success: false, error: "Method not allowed" });
  } catch (error) {
    if (handleConfigError(res, error)) return;
    console.error("round-members API error:", error);
    return res.status(500).json({ success: false, error: error.message || "Internal server error" });
  }
}
