import { sbGet, sbInsert, sbPatch, setCors, handleConfigError } from "../lib/supabase.js";

// GET  /api/public-round?token=xxxx
//   -> { round, participants } for the secure, no-login round page.
// POST /api/public-round
//   body: { token, member_id, department, domain, checklist_item, observation_text,
//           location, immediate_action, suggested_action, comments, evidence_url }
//   -> creates one observation row, status "Submitted for QPS Review".
//
// No system account is required — the token itself is the access control
// (it is a long random string generated when the round was scheduled, see
// api/rounds.js). The member identifies themselves from the list of people
// actually linked to this round (round_participants), so member name/role
// are recorded automatically once they pick themselves — never freeform.

async function recordRoundActivity(roundId, member, completed=false) {
  const phone = member?.mobile || null;
  const now = new Date().toISOString();
  const q = `?link_type=eq.round&entity_id=eq.${encodeURIComponent(roundId)}&recipient_phone=${phone?`eq.${encodeURIComponent(phone)}`:'is.null'}`;
  const rows = await sbGet("secure_link_activity", q);
  if (rows.length) {
    await sbPatch("secure_link_activity", `?id=eq.${rows[0].id}`, { last_opened_at: now, open_count: (rows[0].open_count||1)+1, ...(completed?{action_completed_at:now}:{}) }, "minimal");
  } else {
    await sbInsert("secure_link_activity", [{ link_type:"round", entity_id:roundId, recipient_name:member?.full_name||null, recipient_phone:phone, first_opened_at:now, last_opened_at:now, open_count:1, action_completed_at:completed?now:null }], "minimal");
  }
}

export default async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(200).end();

  try {
    if (req.method === "GET") {
      const token = req.query.token;
      if (!token) return res.status(400).json({ success: false, error: "token is required." });

      const rounds = await sbGet("rounds", `?secure_token=eq.${encodeURIComponent(token)}`);
      if (!rounds.length) return res.status(404).json({ success: false, error: "Round link not found or expired." });
      const round = rounds[0];

      const participants = await sbGet(
        "round_participants",
        `?round_id=eq.${encodeURIComponent(round.id)}&select=member_id,round_members(id,full_name,job_title,department,mobile)`
      );

      return res.status(200).json({
        success: true,
        round: { id: round.id, departments: round.departments, planned_date: round.planned_date, planned_time: round.planned_time, status: round.status },
        participants: participants.map((p) => p.round_members).filter(Boolean),
      });
    }

    if (req.method === "POST") {
      const b = req.body || {};
      if (!b.token || !b.member_id || !b.domain || !b.checklist_item || !b.observation_text) {
        return res.status(400).json({ success: false, error: "token, member_id, domain, checklist_item and observation_text are required." });
      }

      const rounds = await sbGet("rounds", `?secure_token=eq.${encodeURIComponent(b.token)}`);
      if (!rounds.length) return res.status(404).json({ success: false, error: "Round link not found or expired." });
      const round = rounds[0];

      const members = await sbGet("round_members", `?id=eq.${encodeURIComponent(b.member_id)}`);
      if (!members.length) return res.status(404).json({ success: false, error: "Member not recognized for this round." });
      const member = members[0];

      if (b.action === "link_open") {
        await recordRoundActivity(round.id, member, false);
        return res.status(200).json({ success: true });
      }

      const row = {
        round_id: round.id,
        member_name: member.full_name,
        member_role: member.job_title,
        department: b.department || member.department,
        domain: b.domain,
        checklist_item: b.checklist_item,
        observation_text: b.observation_text,
        location: b.location || null,
        immediate_action: b.immediate_action || null,
        suggested_action: b.suggested_action || null,
        evidence_url: b.evidence_url || null,
        status: "Submitted for QPS Review",
        submitted_at: new Date().toISOString(),
      };
      const inserted = await sbInsert("observations", [row]);
      await recordRoundActivity(round.id, member, true);
      return res.status(200).json({ success: true, observation: inserted[0] });
    }

    return res.status(405).json({ success: false, error: "Method not allowed" });
  } catch (error) {
    if (handleConfigError(res, error)) return;
    console.error("public-round API error:", error);
    return res.status(500).json({ success: false, error: error.message || "Internal server error" });
  }
}
