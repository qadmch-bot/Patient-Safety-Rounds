import {
  sbGet,
  sbInsert,
  sbPatch,
  logAudit,
  setCors,
  handleConfigError
} from "../lib/supabase.js";

import {
  sendTwilioMessageRaw,
  sendTwilioTemplate
} from "../lib/twilio-send.js";

import { normalizeToE164 } from "../lib/phone.js";


/* =========================================================
   WHATSAPP API - PATIENT SAFETY ROUNDS
   =========================================================

   ?action=manual-send
     GET  -> WhatsApp message history
     POST -> Send approved WhatsApp attendance template

   ?action=templates
     GET   -> List WhatsApp templates
     PATCH -> Update template approval status

   ?action=send
     POST -> Direct WhatsApp test/manual message
             داخل نافذة الـ 24 ساعة فقط
*/


/* =========================================================
   APPROVED ATTENDANCE TEMPLATE
   ========================================================= */

const ATTENDANCE_TEMPLATE_NAME =
  "patient_safety_round_attendance";

const ATTENDANCE_CONTENT_SID =
  "HX447d377620816baa3eb67f840520f59f";


/* =========================================================
   MAIN HANDLER
   ========================================================= */

export default async function handler(req, res) {

  setCors(res);

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  const action = req.query.action;

  try {

    if (action === "templates") {
      return await handleTemplates(req, res);
    }

    if (action === "manual-send") {
      return await handleManualSend(req, res);
    }

    if (action === "send") {
      return await handleDirectSend(req, res);
    }

    return res.status(400).json({
      success: false,
      error:
        "action must be 'manual-send', 'templates', or 'send'."
    });

  } catch (error) {

    if (handleConfigError(res, error)) return;

    console.error("WhatsApp API error:", error);

    return res.status(500).json({
      success: false,
      error:
        error.message ||
        "Internal server error"
    });
  }
}


/* =========================================================
   TEMPLATES
   ========================================================= */

async function handleTemplates(req, res) {

  if (req.method === "GET") {

    const templates = await sbGet(
      "whatsapp_templates",
      "?order=name.asc"
    );

    return res.status(200).json({
      success: true,
      templates
    });
  }


  if (req.method === "PATCH") {

    const name = req.query.name;

    if (!name) {
      return res.status(400).json({
        success: false,
        error:
          "name query param is required."
      });
    }

    const body = req.body || {};

    if (
      !["Approved", "Pending", "Rejected"]
        .includes(body.status)
    ) {
      return res.status(400).json({
        success: false,
        error:
          "status must be Approved, Pending or Rejected."
      });
    }

    const updated = await sbPatch(
      "whatsapp_templates",
      `?name=eq.${encodeURIComponent(name)}`,
      {
        status: body.status,
        updated_at:
          new Date().toISOString()
      }
    );

    await logAudit({
      action:
        "WhatsApp Template Status Changed",
      entity_type:
        "whatsapp_template",
      entity_id: name,
      actor: body.actor,
      new_value: {
        status: body.status
      }
    });

    return res.status(200).json({
      success: true,
      template: updated[0]
    });
  }


  return res.status(405).json({
    success: false,
    error: "Method not allowed"
  });
}


/* =========================================================
   DATE / TIME FORMATTERS
   ========================================================= */

function formatRoundDate(round) {

  const rawDate =
    round.round_date ||
    round.date ||
    round.scheduled_date ||
    round.scheduled_at ||
    round.start_at ||
    null;

  if (!rawDate) {
    return "حسب الموعد المحدد";
  }

  try {

    const date = new Date(rawDate);

    if (Number.isNaN(date.getTime())) {
      return String(rawDate);
    }

    return new Intl.DateTimeFormat(
      "ar-SA",
      {
        timeZone: "Asia/Riyadh",
        year: "numeric",
        month: "2-digit",
        day: "2-digit"
      }
    ).format(date);

  } catch {

    return String(rawDate);
  }
}


function formatRoundTime(round) {

  /*
    إذا كانت قاعدة البيانات تحتوي وقتاً منفصلاً
    مثل round_time نستخدمه مباشرة.
  */

  const directTime =
    round.round_time ||
    round.time ||
    round.scheduled_time ||
    null;

  if (directTime) {
    return String(directTime);
  }


  const rawDate =
    round.scheduled_at ||
    round.start_at ||
    round.round_date ||
    round.date ||
    null;

  if (!rawDate) {
    return "حسب الموعد المحدد";
  }

  try {

    const date = new Date(rawDate);

    if (Number.isNaN(date.getTime())) {
      return String(rawDate);
    }

    return new Intl.DateTimeFormat(
      "ar-SA",
      {
        timeZone: "Asia/Riyadh",
        hour: "numeric",
        minute: "2-digit",
        hour12: true
      }
    ).format(date);

  } catch {

    return String(rawDate);
  }
}


/* =========================================================
   MANUAL SEND
   APPROVED WHATSAPP ATTENDANCE TEMPLATE
   ========================================================= */

async function handleManualSend(req, res) {

  /* -------------------------
     GET MESSAGE HISTORY
     ------------------------- */

  if (req.method === "GET") {

    let query =
      "?order=created_at.desc&limit=200";

    if (req.query.round_id) {
      query +=
        `&round_id=eq.${encodeURIComponent(
          req.query.round_id
        )}`;
    }

    if (req.query.status) {
      query +=
        `&status=eq.${encodeURIComponent(
          req.query.status
        )}`;
    }

    if (req.query.recipient) {
      query +=
        `&recipient_mobile=ilike.*${encodeURIComponent(
          req.query.recipient
        )}*`;
    }

    if (req.query.date) {
      query +=
        `&created_at=gte.${encodeURIComponent(
          req.query.date
        )}`;
    }

    const rows = await sbGet(
      "whatsapp_manual_messages",
      query
    );

    return res.status(200).json({
      success: true,
      messages: rows
    });
  }


  /* -------------------------
     POST ONLY
     ------------------------- */

  if (req.method !== "POST") {
    return res.status(405).json({
      success: false,
      error: "Method not allowed"
    });
  }


  const body = req.body || {};


  /* -------------------------
     VALIDATE ROUND
     ------------------------- */

  if (!body.round_id) {
    return res.status(400).json({
      success: false,
      error: "round_id is required."
    });
  }


  /* -------------------------
     VALIDATE RECIPIENTS
     ------------------------- */

  if (
    !Array.isArray(body.recipients) ||
    !body.recipients.length
  ) {
    return res.status(400).json({
      success: false,
      error:
        "At least one recipient is required."
    });
  }


  /* =====================================================
     GET ROUND
     ===================================================== */

  const rounds = await sbGet(
    "rounds",
    `?id=eq.${encodeURIComponent(
      body.round_id
    )}`
  );

  if (!rounds.length) {
    return res.status(404).json({
      success: false,
      error: "Round not found."
    });
  }

  const round = rounds[0];


  /* =====================================================
     TEMPLATE VARIABLES

     {{1}} = Round Date
     {{2}} = Round Time
     ===================================================== */

  const roundDate =
    formatRoundDate(round);

  const roundTime =
    formatRoundTime(round);


  const contentVariables = {
    "1": roundDate,
    "2": roundTime
  };


  /* =====================================================
     SEND TO RECIPIENTS
     ===================================================== */

  const results = [];


  for (const recipient of body.recipients) {

    const mobile =
      normalizeToE164(
        recipient.mobile
      );


    const row = {

      round_id:
        body.round_id,

      recipient_name:
        recipient.name || null,

      recipient_mobile:
        recipient.mobile || "",

      language:
        "ar",

      template_name:
        ATTENDANCE_TEMPLATE_NAME,

      sent_by:
        body.sent_by ||
        "Quality Admin",

      status:
        "pending"
    };


    /* -------------------------
       INVALID NUMBER
       ------------------------- */

    if (!mobile) {

      row.status =
        "failed";

      row.failure_reason =
        "Invalid mobile number format.";

      const inserted =
        await sbInsert(
          "whatsapp_manual_messages",
          [row]
        );

      results.push(
        inserted[0]
      );

      continue;
    }


    row.recipient_mobile =
      mobile;


    /* =====================================================
       SEND APPROVED TWILIO TEMPLATE

       IMPORTANT:
       NO Body
       NO raw WhatsApp message

       ContentSid + ContentVariables
       ===================================================== */

    const sendResult =
      await sendTwilioTemplate({

        to:
          mobile,

        contentSid:
          ATTENDANCE_CONTENT_SID,

        variables:
          contentVariables
      });


    /* -------------------------
       SUCCESS
       ------------------------- */

    if (sendResult.success) {

      row.status =
        "sent";

      row.message_sid =
        sendResult.sid;

      row.sent_at =
        new Date().toISOString();

    }

    /* -------------------------
       FAILED
       ------------------------- */

    else {

      row.status =
        "failed";

      row.failure_reason =
        sendResult.code
          ? `${sendResult.error} (Twilio ${sendResult.code})`
          : sendResult.error;
    }


    const inserted =
      await sbInsert(
        "whatsapp_manual_messages",
        [row]
      );


    results.push(
      inserted[0]
    );
  }


  /* =====================================================
     FINAL RESULT
     ===================================================== */

  const anySuccess =
    results.some(
      result =>
        result.status === "sent"
    );


  return res.status(200).json({

    success:
      anySuccess,

    template:
      ATTENDANCE_TEMPLATE_NAME,

    content_sid:
      ATTENDANCE_CONTENT_SID,

    variables:
      contentVariables,

    results
  });
}


/* =========================================================
   DIRECT TEST SEND
   RAW BODY MESSAGE

   يعمل فقط داخل نافذة WhatsApp 24 ساعة.
   أبقيناه حتى لا تتعطل خاصية الاختبار الحالية.
   ========================================================= */

async function handleDirectSend(req, res) {

  if (req.method !== "POST") {
    return res.status(405).json({
      success: false,
      error: "Method not allowed"
    });
  }


  const body =
    req.body || {};


  const to =
    normalizeToE164(
      body.to
    );


  if (!to) {
    return res.status(400).json({
      success: false,
      error:
        "Valid recipient number is required."
    });
  }


  const message =
    body.message ||
    "اختبار نظام جولات سلامة المرضى - تم الاتصال بخدمة WhatsApp بنجاح.";


  const result =
    await sendTwilioMessageRaw({
      to,
      message
    });


  if (!result.success) {

    return res.status(500).json({

      success:
        false,

      error:
        result.error ||
        "Twilio request failed",

      code:
        result.code || null
    });
  }


  return res.status(200).json({

    success:
      true,

    sid:
      result.sid,

    status:
      result.status || "sent",

    to
  });
}


// redeploy
