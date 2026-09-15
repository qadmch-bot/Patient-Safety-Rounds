import { sbGet, sbInsert, sbPatch, sbDelete, logAudit, setCors, handleConfigError } from "../lib/supabase.js";

// GET    /api/rounds                  → list all rounds (chronological)
// GET    /api/rounds?id=PSR-2026-013   → single round + its participants
// POST   /api/rounds                  → create a round (+ optional member_ids[] to link)
// PATCH  /api/rounds?id=PSR-2026-013   → update/reschedule/cancel a round
// DELETE /api/rounds?id=PSR-2026-013   → remove a round (cascades participants)
//
// Body shape (POST/PATCH):
// { id, departments:[], planned_date, planned_time, team, lead_reviewer,
//   department_representative, notes, status, member_ids:[] }

function randomToken() {
  return [...crypto.getRandomValues(new Uint8Array(24))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export default async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(200).end();

  try {
    if (req.method === "GET") {
      if (req.query.id) {
        const rows = await sbGet("rounds", `?id=eq.${encodeURIComponent(req.query.id)}`);
        if (!rows.length) return res.status(404).json({ success: false, error: "Round not found" });
        const participants = await sbGet(
          "round_participants",
          `?round_id=eq.${encodeURIComponent(req.query.id)}&select=member_id,round_members(id,full_name,job_title,department,mobile,whatsapp_enabled,preferred_language)`
        );
        return res.status(200).json({ success: true, round: rows[0], participants });
      }
      const rows = await sbGet("rounds", "?order=planned_date.asc");
      return res.status(200).json({ success: true, rounds: rows });
    }

    if (req.method === "POST") {
      const b = req.body || {};
      if (!b.id || !b.departments || !b.planned_date) {
        return res.status(400).json({ success: false, error: "id, departments and planned_date are required." });
      }
      const row = {
        id: b.id,
        departments: b.departments,
        planned_date: b.planned_date,
        planned_time: b.planned_time || "10:00",
        team: b.team || null,
        lead_reviewer: b.lead_reviewer || null,
        department_representative: b.department_representative || null,
        notes: b.notes || null,
        status: b.status || "Scheduled",
        secure_token: randomToken(),
      };
      const inserted = await sbInsert("rounds", [row]);

      if (Array.isArray(b.member_ids) && b.member_ids.length) {
        await sbInsert(
          "round_participants",
          b.member_ids.map((mid) => ({ round_id: row.id, member_id: mid })),
          "minimal"
        );
      }

      await logAudit({ action: "Round Created", entity_type: "round", entity_id: row.id, actor: b.actor, new_value: row });
      return res.status(200).json({ success: true, round: inserted[0], secure_link: `/round/${row.secure_token}` });
    }

    if (req.method === "PATCH") {
      const id = req.query.id;
      if (!id) return res.status(400).json({ success: false, error: "id query param is required." });
      const b = req.body || {};
      const patch = {};
      ["departments", "planned_date", "planned_time", "team", "lead_reviewer", "department_representative", "notes", "status"].forEach((k) => {
        if (b[k] !== undefined) patch[k] = b[k];
      });
      patch.updated_at = new Date().toISOString();
      const updated = await sbPatch("rounds", `?id=eq.${encodeURIComponent(id)}`, patch);

      if (Array.isArray(b.member_ids)) {
        await sbDelete("round_participants", `?round_id=eq.${encodeURIComponent(id)}`);
        if (b.member_ids.length) {
          await sbInsert(
            "round_participants",
            b.member_ids.map((mid) => ({ round_id: id, member_id: mid })),
            "minimal"
          );
        }
      }

      // Date/time changed → old reminders for this round must not fire against
      // the stale schedule (spec section 6). Cancel any still-pending ones;
      // the frontend is expected to call /api/create-reminder again afterwards.
      if (b.planned_date !== undefined || b.planned_time !== undefined) {
        await sbPatch("whatsapp_reminders", `?round_id=eq.${encodeURIComponent(id)}&status=eq.pending`, {
          status: "cancelled",
          updated_at: new Date().toISOString(),
        }, "minimal").catch(() => {});
      }

      await logAudit({ action: "Round Updated", entity_type: "round", entity_id: id, actor: b.actor, new_value: patch });
      return res.status(200).json({ success: true, round: updated[0] });
    }

    if (req.method === "DELETE") {
      const id = req.query.id;
      if (!id) return res.status(400).json({ success: false, error: "id query param is required." });
      await sbDelete("rounds", `?id=eq.${encodeURIComponent(id)}`);
      await logAudit({ action: "Round Deleted", entity_type: "round", entity_id: id });
      return res.status(200).json({ success: true });
    }

    return res.status(405).json({ success: false, error: "Method not allowed" });
  } catch (error) {
    if (handleConfigError(res, error)) return;
    console.error("rounds API error:", error);
    return res.status(500).json({ success: false, error: error.message || "Internal server error" });
  }
}
