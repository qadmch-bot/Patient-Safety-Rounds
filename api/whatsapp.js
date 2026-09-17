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

/*
  Patient Safety Rounds - WhatsApp API

  الإرسال اليدوي غير مقيد بموعد الجولة.
  تستطيع إدارة الجودة إرسال:
  1) إشعار الجولة في أي وقت
  2) تذكير بقرب الجولة في أي وقت
  3) تذكير برفع الخطة التصحيحية والأدلة
  4) رسالة مخصصة

  ملاحظة:
  WhatsApp/Meta يشترط قالباً معتمداً للرسائل
  Business-Initiated خارج نافذة المحادثة 24 ساعة.
*/

const ATTENDANCE_TEMPLATE_NAME =
  "patient_safety_round_attendance";

const ATTENDANCE_CONTENT_SID =
  "HX447d377620816baa3eb67f840520f59f";


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
   WHATSAPP TEMPLATES
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
        error: "name query param is required."
      });
    }


    const body = req.body || {};


    if (
      ![
        "Approved",
        "Pending",
        "Rejected"
      ].includes(body.status)
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

      entity_id:
        name,

      actor:
        body.actor,

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
   ROUND DATE
   ========================================================= */

function formatRoundDate(round) {

  const raw =
    round.planned_date ||
    round.round_date ||
    round.date ||
    round.scheduled_at ||
    null;


  if (!raw) {
    return "حسب الموعد المحدد";
  }


  if (
    /^\d{4}-\d{2}-\d{2}$/.test(
      String(raw)
    )
  ) {

    const [year, month, day] =
      String(raw).split("-");

    return `${day}/${month}/${year}`;
  }


  try {

    const date = new Date(raw);

    if (
      Number.isNaN(
        date.getTime()
      )
    ) {
      return String(raw);
    }


    return new Intl.DateTimeFormat(
      "ar-SA",
      {
        timeZone:
          "Asia/Riyadh",

        year:
          "numeric",

        month:
          "2-digit",

        day:
          "2-digit"
      }
    ).format(date);

  } catch {

    return String(raw);
  }
}


/* =========================================================
   ROUND TIME
   ========================================================= */

function formatRoundTime(round) {

  const direct =
    round.planned_time ||
    round.round_time ||
    round.time ||
    round.scheduled_time ||
    null;


  if (direct) {

    return String(direct)
      .slice(0, 5);
  }


  const raw =
    round.scheduled_at ||
    round.start_at ||
    null;


  if (!raw) {

    return "حسب الموعد المحدد";
  }


  try {

    const date =
      new Date(raw);


    if (
      Number.isNaN(
        date.getTime()
      )
    ) {

      return String(raw);
    }


    return new Intl.DateTimeFormat(
      "ar-SA",
      {
        timeZone:
          "Asia/Riyadh",

        hour:
          "numeric",

        minute:
          "2-digit",

        hour12:
          true
      }
    ).format(date);

  } catch {

    return String(raw);
  }
}


/* =========================================================
   CORRECTIVE PLAN MESSAGE
   ========================================================= */

function buildPlanFallbackMessage(round) {

  return `تذكير برفع الخطة التصحيحية والأدلة

يرجى استكمال ورفع الخطة التصحيحية والأدلة المتعلقة بجولة سلامة المرضى ${round.id}.

إدارة الجودة وسلامة المرضى
مستشفى الولادة والأطفال – حفر الباطن`;
}


/* =========================================================
   MANUAL WHATSAPP SEND
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


    const rows =
      await sbGet(
        "whatsapp_manual_messages",
        query
      );


    return res.status(200).json({
      success: true,
      messages: rows
    });
  }


  /* -------------------------
     POST MANUAL MESSAGE
     ------------------------- */

  if (req.method !== "POST") {

    return res.status(405).json({
      success: false,
      error:
        "Method not allowed"
    });
  }


  const body =
    req.body || {};


  const messageType =
    body.message_type ||
    "round_notice";


  if (!body.round_id) {

    return res.status(400).json({
      success: false,
      error:
        "round_id is required."
    });
  }


  if (
    !Array.isArray(
      body.recipients
    ) ||
    !body.recipients.length
  ) {

    return res.status(400).json({
      success: false,
      error:
        "At least one recipient is required."
    });
  }


  /* -------------------------
     LOAD ROUND
     ------------------------- */

  const rounds =
    await sbGet(
      "rounds",
      `?id=eq.${encodeURIComponent(
        body.round_id
      )}`
    );


  if (!rounds.length) {

    return res.status(404).json({
      success: false,
      error:
        "Round not found."
    });
  }


  const round =
    rounds[0];


  const roundDate =
    formatRoundDate(round);


  const roundTime =
    formatRoundTime(round);


  const results = [];


  /* =====================================================
     SEND TO EACH RECIPIENT
     ===================================================== */

  for (
    const recipient
    of body.recipients
  ) {


    const mobile =
      normalizeToE164(
        recipient.mobile
      );


    const row = {

      round_id:
        body.round_id,

      recipient_name:
        recipient.name ||
        null,

      recipient_mobile:
        recipient.mobile ||
        "",

      language:
        body.language === "en"
          ? "en"
          : "ar",

      template_name:
        messageType ===
        "plan_reminder"

          ? "corrective_plan_reminder"

          : messageType ===
            "custom"

            ? "custom_message"

            : ATTENDANCE_TEMPLATE_NAME,

      sent_by:
        body.sent_by ||
        "Quality Admin",

      status:
        "pending"
    };


    /* -------------------------
       INVALID MOBILE
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


    let sendResult;


    /* =====================================================
       TYPE 1
       ROUND NOTIFICATION
       ===================================================== */

    if (
      messageType ===
        "round_notice" ||

      messageType ===
        "round_1h"
    ) {


      sendResult =
        await sendTwilioTemplate({

          to:
            mobile,

          contentSid:
            ATTENDANCE_CONTENT_SID,

          variables: {

            "1":
              roundDate,

            "2":
              roundTime
          }
        });
    }


    /* =====================================================
       TYPE 2
       CORRECTIVE PLAN REMINDER
       ===================================================== */

    else if (
      messageType ===
      "plan_reminder"
    ) {


      const planSid =
        process.env
          .TWILIO_PLAN_TEMPLATE_SID;


      /*
        عندما ننشئ قالب الخطة التصحيحية
        في Twilio سنضع Content SID
        في Vercel باسم:

        TWILIO_PLAN_TEMPLATE_SID
      */


      if (planSid) {


        sendResult =
          await sendTwilioTemplate({

            to:
              mobile,

            contentSid:
              planSid,

            variables: {

              "1":
                String(
                  round.id
                )
            }
          });


      } else {


        /*
          مؤقتاً:
          يمكن إرسال الرسالة الحرة
          إذا كانت نافذة 24 ساعة مفتوحة.
        */


        sendResult =
          await sendTwilioMessageRaw({

            to:
              mobile,

            message:
              buildPlanFallbackMessage(
                round
              )
          });
      }
    }


    /* =====================================================
       TYPE 3
       CUSTOM MESSAGE
       ===================================================== */

    else if (
      messageType ===
      "custom"
    ) {


      const custom =
        String(
          body.custom_message ||
          ""
        ).trim();


      if (!custom) {


        sendResult = {

          success:
            false,

          error:
            "Custom message text is required."
        };


      } else {


        sendResult =
          await sendTwilioMessageRaw({

            to:
              mobile,

            message:
              custom
          });
      }
    }


    /* =====================================================
       UNKNOWN TYPE
       ===================================================== */

    else {


      sendResult = {

        success:
          false,

        error:
          "Unknown message_type."
      };
    }


    /* =====================================================
       SAVE SEND RESULT
       ===================================================== */

    if (
      sendResult.success
    ) {


      row.status =
        "sent";


      row.message_sid =
        sendResult.sid;


      row.sent_at =
        new Date()
          .toISOString();


    } else {


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
     RESPONSE
     ===================================================== */


  const anySuccess =
    results.some(
      r =>
        r.status ===
        "sent"
    );


  return res.status(200).json({

    success:
      anySuccess,

    message_type:
      messageType,

    round_id:
      round.id,

    round_date:
      roundDate,

    round_time:
      roundTime,

    results
  });
}


/* =========================================================
   DIRECT / TEST MESSAGE
   ========================================================= */

async function handleDirectSend(
  req,
  res
) {


  if (
    req.method !==
    "POST"
  ) {

    return res.status(405).json({

      success:
        false,

      error:
        "Method not allowed"
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

      success:
        false,

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
        result.code ||
        null
    });
  }


  return res.status(200).json({

    success:
      true,

    sid:
      result.sid,

    status:
      result.status ||
      "sent",

    to
  });
}
