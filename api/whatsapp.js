import {
  sbGet,
  sbInsert,
  sbPatch,
  logAudit,
  setCors,
  handleConfigError
} from "../lib/supabase.js";

import { sendTwilioMessageRaw } from "../lib/twilio-send.js";
import { manualRoundMessage } from "../lib/messages.js";
import { normalizeToE164 } from "../lib/phone.js";

// Single WhatsApp endpoint.
//
// Supported actions:
//
// ?action=manual-send
//   GET  -> Manual WhatsApp message history
//   POST -> Send a Patient Safety Round WhatsApp message
//
// ?action=templates
//   GET   -> List WhatsApp templates
//   PATCH -> Update template approval status
//
// ?action=send
//   POST -> Direct WhatsApp test/manual message

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
      error: "action must be 'manual-send', 'templates', or 'send'."
    });

  } catch (error) {
    if (handleConfigError(res, error)) {
      return;
    }

    console.error("whatsapp API error:", error);

    return res.status(500).json({
      success: false,
      error: error.message || "Internal server error"
    });
  }
}


// =====================================================
// action=templates
// Formerly: api/whatsapp-templates.js
// =====================================================

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

    const b = req.body || {};

    if (!["Approved", "Pending", "Rejected"].includes(b.status)) {
      return res.status(400).json({
        success: false,
        error: "status must be Approved, Pending or Rejected."
      });
    }

    const updated = await sbPatch(
      "whatsapp_templates",
      `?name=eq.${encodeURIComponent(name)}`,
      {
        status: b.status,
        updated_at: new Date().toISOString()
      }
    );

    await logAudit({
      action: "WhatsApp Template Status Changed",
      entity_type: "whatsapp_template",
      entity_id: name,
      actor: b.actor,
      new_value: {
        status: b.status
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


// =====================================================
// action=manual-send
// Formerly: api/whatsapp-manual-send.js
// =====================================================

async function handleManualSend(req, res) {

  // ---------------------------------------------------
  // GET — Manual WhatsApp Message History
  // ---------------------------------------------------

  if (req.method === "GET") {

    let query = "?order=created_at.desc&limit=200";

    if (req.query.round_id) {
      query += `&round_id=eq.${encodeURIComponent(
        req.query.round_id
      )}`;
    }

    if (req.query.status) {
      query += `&status=eq.${encodeURIComponent(
        req.query.status
      )}`;
    }

    if (req.query.recipient) {
      query += `&recipient_mobile=ilike.*${encodeURIComponent(
        req.query.recipient
      )}*`;
    }

    if (req.query.date) {
      query += `&created_at=gte.${encodeURIComponent(
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


  // ---------------------------------------------------
  // POST — Send Manual Round WhatsApp Message
  // ---------------------------------------------------

  if (req.method !== "POST") {
    return res.status(405).json({
      success: false,
      error: "Method not allowed"
    });
  }


  const b = req.body || {};


  // Validate round

  if (!b.round_id) {
    return res.status(400).json({
      success: false,
      error: "round_id is required."
    });
  }


  // Validate recipients

  if (
    !Array.isArray(b.recipients) ||
    !b.recipients.length
  ) {
    return res.status(400).json({
      success: false,
      error: "At least one recipient is required."
    });
  }


  // Validate template

  if (!b.template_name) {
    return res.status(400).json({
      success: false,
      error: "template_name is required."
    });
  }


  // ---------------------------------------------------
  // Get WhatsApp Template
  // ---------------------------------------------------

  const templates = await sbGet(
    "whatsapp_templates",
    `?name=eq.${encodeURIComponent(
      b.template_name
    )}`
  );

  const template = templates[0];


  if (!template) {
    return res.status(400).json({
      success: false,
      error: "Unknown template."
    });
  }


  // Only Approved templates can be used

  if (template.status !== "Approved") {

    return res.status(400).json({
      success: false,
      error:
        `Cannot send — template "${b.template_name}" ` +
        `is not Approved (current status: ${template.status}). ` +
        `Business-initiated WhatsApp messages require an approved template.`
    });
  }


  // ---------------------------------------------------
  // Get Patient Safety Round
  // ---------------------------------------------------

  const rounds = await sbGet(
    "rounds",
    `?id=eq.${encodeURIComponent(
      b.round_id
    )}`
  );


  if (!rounds.length) {
    return res.status(404).json({
      success: false,
      error: "Round not found."
    });
  }


  const round = rounds[0];


  // ---------------------------------------------------
  // Build Secure Round Link
  // ---------------------------------------------------

  const proto =
    req.headers["x-forwarded-proto"] ||
    "https";

  const host =
    req.headers.host ||
    "patient-safety-rounds.vercel.app";


  const link =
    `${proto}://${host}/round/${round.secure_token}`;


  // ---------------------------------------------------
  // Message Language
  // ---------------------------------------------------

  const lang =
    b.language === "en"
      ? "en"
      : "ar";


  // ---------------------------------------------------
  // Generate Message
  // ---------------------------------------------------

  const message = manualRoundMessage({
    lang,
    round,
    link
  });


  // ---------------------------------------------------
  // Send to Recipients
  // ---------------------------------------------------

  const results = [];


  for (const recipient of b.recipients) {

    const mobile =
      normalizeToE164(
        recipient.mobile
      );


    const row = {

      round_id:
        b.round_id,

      recipient_name:
        recipient.name || null,

      recipient_mobile:
        recipient.mobile || "",

      language:
        lang,

      template_name:
        b.template_name,

      sent_by:
        b.sent_by ||
        "Quality Admin",

      status:
        "pending"
    };


    // Invalid mobile

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


    // -------------------------------------------------
    // Send WhatsApp
    // -------------------------------------------------

    const sendResult =
      await sendTwilioMessageRaw({
        to: mobile,
        message
      });


    if (sendResult.success) {

      row.status =
        "sent";

      row.message_sid =
        sendResult.sid;

      row.sent_at =
        new Date().toISOString();

    } else {

      row.status =
        "failed";

      row.failure_reason =
        sendResult.error;
    }


    // -------------------------------------------------
    // Store Message Log
    // -------------------------------------------------

    const inserted =
      await sbInsert(
        "whatsapp_manual_messages",
        [row]
      );


    results.push(
      inserted[0]
    );
  }


  const anySuccess =
    results.some(
      (r) =>
        r.status === "sent"
    );


  return res.status(200).json({

    success:
      anySuccess,

    results,

    message_preview:
      message
  });
}


// =====================================================
// action=send
// Direct WhatsApp Test / Manual Message
// Replaces api/send-whatsapp.js
// =====================================================

async function handleDirectSend(req, res) {

  if (req.method !== "POST") {

    return res.status(405).json({
      success: false,
      error: "Method not allowed"
    });
  }


  const body =
    req.body || {};


  // ---------------------------------------------------
  // Validate / Normalize Recipient
  // ---------------------------------------------------

  const to =
    normalizeToE164(
      body.to
    );


  if (!to) {

    return res.status(400).json({
      success: false,
      error: "Valid recipient number is required."
    });
  }


  // ---------------------------------------------------
  // Message
  // ---------------------------------------------------

  const message =
    body.message ||
    "اختبار نظام جولات سلامة المرضى - تم الاتصال بخدمة WhatsApp بنجاح.";


  // ---------------------------------------------------
  // Send through Twilio
  // ---------------------------------------------------

  const result =
    await sendTwilioMessageRaw({
      to,
      message
    });


  if (!result.success) {

    return res.status(500).json({
      success: false,
      error:
        result.error ||
        "Twilio request failed"
    });
  }


  // ---------------------------------------------------
  // Success
  // ---------------------------------------------------

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
