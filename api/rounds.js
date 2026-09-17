import {
  sbGet,
  sbInsert,
  sbPatch,
  sbDelete,
  logAudit,
  setCors,
  handleConfigError
} from "../lib/supabase.js";

// GET    /api/rounds
// GET    /api/rounds?id=PSR-2026-014
// POST   /api/rounds
// PATCH  /api/rounds?id=PSR-2026-014
// DELETE /api/rounds?id=PSR-2026-014

function randomToken() {
  return [...crypto.getRandomValues(new Uint8Array(24))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export default async function handler(req, res) {
  setCors(res);

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  try {

    /* =========================================================
       GET
       ========================================================= */
    if (req.method === "GET") {

      /* ---------- Single round + participants + attendance ---------- */
      if (req.query.id) {

        const roundId = req.query.id;

        const rows = await sbGet(
          "rounds",
          `?id=eq.${encodeURIComponent(roundId)}`
        );

        if (!rows.length) {
          return res.status(404).json({
            success: false,
            error: "Round not found"
          });
        }

        /*
          IMPORTANT:
          attendance_status and attendance_responded_at
          are stored in round_participants.

          We return them together with round_members
          so the frontend can display:

          Confirmed → تم تأكيد الحضور
          Declined  → تعذر الحضور
          Pending   → بانتظار الرد
        */
        const participants = await sbGet(
          "round_participants",
          `?round_id=eq.${encodeURIComponent(roundId)}&select=member_id,attendance_status,attendance_responded_at,round_members(id,full_name,job_title,department,mobile,whatsapp_enabled,preferred_language)`
        );

        /*
          Also create a frontend-friendly version.

          This keeps the original round_members object
          AND adds attendance fields directly to it.

          Therefore old frontend code continues working:
          p.round_members

          while attendance becomes available as:
          p.attendance_status
          p.attendance_responded_at

          and also:
          p.round_members.attendance_status
        */
        const participantsWithAttendance = participants.map((p) => ({
          ...p,

          attendance_status:
            p.attendance_status || "Pending",

          attendance_responded_at:
            p.attendance_responded_at || null,

          round_members: p.round_members
            ? {
                ...p.round_members,

                attendance_status:
                  p.attendance_status || "Pending",

                attendance_responded_at:
                  p.attendance_responded_at || null
              }
            : null
        }));

        return res.status(200).json({
          success: true,
          round: rows[0],
          participants: participantsWithAttendance
        });
      }

      /* ---------- List all rounds ---------- */
      const rows = await sbGet(
        "rounds",
        "?order=planned_date.asc"
      );

      return res.status(200).json({
        success: true,
        rounds: rows
      });
    }


    /* =========================================================
       POST — CREATE ROUND
       ========================================================= */
    if (req.method === "POST") {

      const b = req.body || {};

      if (!b.id || !b.departments || !b.planned_date) {
        return res.status(400).json({
          success: false,
          error: "id, departments and planned_date are required."
        });
      }

      const row = {
        id: b.id,
        departments: b.departments,
        planned_date: b.planned_date,
        planned_time: b.planned_time || "10:00",
        team: b.team || null,
        lead_reviewer: b.lead_reviewer || null,
        department_representative:
          b.department_representative || null,
        notes: b.notes || null,
        status: b.status || "Scheduled",
        secure_token: randomToken()
      };

      const inserted = await sbInsert(
        "rounds",
        [row]
      );


      /* ---------- Add selected members ---------- */
      if (
        Array.isArray(b.member_ids) &&
        b.member_ids.length
      ) {

        await sbInsert(
          "round_participants",

          b.member_ids.map((mid) => ({
            round_id: row.id,
            member_id: mid,

            // Every new participant starts Pending
            attendance_status: "Pending",
            attendance_responded_at: null
          })),

          "minimal"
        );
      }


      await logAudit({
        action: "Round Created",
        entity_type: "round",
        entity_id: row.id,
        actor: b.actor,
        new_value: row
      });


      return res.status(200).json({
        success: true,
        round: inserted[0],
        secure_link: `/round/${row.secure_token}`
      });
    }


    /* =========================================================
       PATCH — UPDATE ROUND
       ========================================================= */
    if (req.method === "PATCH") {

      const id = req.query.id;

      if (!id) {
        return res.status(400).json({
          success: false,
          error: "id query param is required."
        });
      }

      const b = req.body || {};

      const patch = {};

      [
        "departments",
        "planned_date",
        "planned_time",
        "team",
        "lead_reviewer",
        "department_representative",
        "notes",
        "status"
      ].forEach((k) => {

        if (b[k] !== undefined) {
          patch[k] = b[k];
        }

      });

      patch.updated_at =
        new Date().toISOString();


      const updated = await sbPatch(
        "rounds",
        `?id=eq.${encodeURIComponent(id)}`,
        patch
      );


      /* =====================================================
         Update participants WITHOUT losing attendance
         ===================================================== */
      if (Array.isArray(b.member_ids)) {

        /*
          Read existing participants first.

          This prevents a confirmed participant from
          becoming Pending again when the round is edited.
        */
        const existingParticipants =
          await sbGet(
            "round_participants",
            `?round_id=eq.${encodeURIComponent(id)}&select=member_id,attendance_status,attendance_responded_at`
          );


        const existingMap = new Map(
          existingParticipants.map((p) => [
            String(p.member_id),
            p
          ])
        );


        await sbDelete(
          "round_participants",
          `?round_id=eq.${encodeURIComponent(id)}`
        );


        if (b.member_ids.length) {

          const participantRows =
            b.member_ids.map((mid) => {

              const previous =
                existingMap.get(String(mid));

              return {
                round_id: id,
                member_id: mid,

                /*
                  Preserve existing attendance
                  if this member was already linked.
                */
                attendance_status:
                  previous?.attendance_status ||
                  "Pending",

                attendance_responded_at:
                  previous?.attendance_responded_at ||
                  null
              };

            });


          await sbInsert(
            "round_participants",
            participantRows,
            "minimal"
          );
        }
      }


      /* =====================================================
         Date/time changed
         Cancel stale pending reminders
         ===================================================== */
      if (
        b.planned_date !== undefined ||
        b.planned_time !== undefined
      ) {

        await sbPatch(
          "whatsapp_reminders",

          `?round_id=eq.${encodeURIComponent(id)}&status=eq.pending`,

          {
            status: "cancelled",
            updated_at:
              new Date().toISOString()
          },

          "minimal"

        ).catch(() => {});
      }


      await logAudit({
        action: "Round Updated",
        entity_type: "round",
        entity_id: id,
        actor: b.actor,
        new_value: patch
      });


      return res.status(200).json({
        success: true,
        round: updated[0]
      });
    }


    /* =========================================================
       DELETE
       ========================================================= */
    if (req.method === "DELETE") {

      const id = req.query.id;

      if (!id) {
        return res.status(400).json({
          success: false,
          error: "id query param is required."
        });
      }


      await sbDelete(
        "rounds",
        `?id=eq.${encodeURIComponent(id)}`
      );


      await logAudit({
        action: "Round Deleted",
        entity_type: "round",
        entity_id: id
      });


      return res.status(200).json({
        success: true
      });
    }


    /* =========================================================
       METHOD NOT ALLOWED
       ========================================================= */
    return res.status(405).json({
      success: false,
      error: "Method not allowed"
    });


  } catch (error) {

    if (handleConfigError(res, error)) {
      return;
    }

    console.error(
      "rounds API error:",
      error
    );

    return res.status(500).json({
      success: false,
      error:
        error.message ||
        "Internal server error"
    });
  }
}
