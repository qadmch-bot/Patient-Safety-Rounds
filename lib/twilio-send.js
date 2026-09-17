import { sbInsert } from "./supabase.js";

/* =========================================================
   TWILIO RAW WHATSAPP MESSAGE
   يستخدم للرسائل العادية داخل نافذة WhatsApp لمدة 24 ساعة
   ========================================================= */

export async function sendTwilioMessageRaw({ to, message }) {
  const {
    TWILIO_ACCOUNT_SID,
    TWILIO_AUTH_TOKEN,
    TWILIO_WHATSAPP_FROM
  } = process.env;

  if (
    !TWILIO_ACCOUNT_SID ||
    !TWILIO_AUTH_TOKEN ||
    !TWILIO_WHATSAPP_FROM
  ) {
    return {
      success: false,
      error: "Twilio environment variables are missing."
    };
  }

  if (!to) {
    return {
      success: false,
      error: "Recipient has no mobile number."
    };
  }

  try {
    const toAddr = to.startsWith("whatsapp:")
      ? to
      : `whatsapp:${to}`;

    const fromAddr = TWILIO_WHATSAPP_FROM.startsWith("whatsapp:")
      ? TWILIO_WHATSAPP_FROM
      : `whatsapp:${TWILIO_WHATSAPP_FROM}`;

    const form = new URLSearchParams();

    form.append("From", fromAddr);
    form.append("To", toAddr);
    form.append("Body", message);

    const auth = Buffer.from(
      `${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`
    ).toString("base64");

    const response = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json`,
      {
        method: "POST",
        headers: {
          Authorization: `Basic ${auth}`,
          "Content-Type": "application/x-www-form-urlencoded"
        },
        body: form.toString()
      }
    );

    const data = await response.json();

    if (!response.ok) {
      return {
        success: false,
        error: data.message || "Twilio request failed",
        code: data.code || null
      };
    }

    return {
      success: true,
      sid: data.sid,
      status: data.status
    };

  } catch (error) {
    return {
      success: false,
      error: error.message
    };
  }
}


/* =========================================================
   TWILIO APPROVED WHATSAPP TEMPLATE
   يستخدم للقوالب المعتمدة من WhatsApp
   ويعمل خارج نافذة الـ 24 ساعة
   ========================================================= */

export async function sendTwilioTemplate({
  to,
  contentSid,
  variables = {}
}) {
  const {
    TWILIO_ACCOUNT_SID,
    TWILIO_AUTH_TOKEN,
    TWILIO_WHATSAPP_FROM
  } = process.env;

  if (
    !TWILIO_ACCOUNT_SID ||
    !TWILIO_AUTH_TOKEN ||
    !TWILIO_WHATSAPP_FROM
  ) {
    return {
      success: false,
      error: "Twilio environment variables are missing."
    };
  }

  if (!to) {
    return {
      success: false,
      error: "Recipient has no mobile number."
    };
  }

  if (!contentSid) {
    return {
      success: false,
      error: "Content SID is required."
    };
  }

  try {
    const toAddr = to.startsWith("whatsapp:")
      ? to
      : `whatsapp:${to}`;

    const fromAddr = TWILIO_WHATSAPP_FROM.startsWith("whatsapp:")
      ? TWILIO_WHATSAPP_FROM
      : `whatsapp:${TWILIO_WHATSAPP_FROM}`;

    const form = new URLSearchParams();

    form.append("From", fromAddr);
    form.append("To", toAddr);

    // IMPORTANT:
    // Approved WhatsApp templates use ContentSid
    // and ContentVariables instead of Body.
    form.append("ContentSid", contentSid);

    form.append(
      "ContentVariables",
      JSON.stringify(variables)
    );

    const auth = Buffer.from(
      `${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`
    ).toString("base64");

    const response = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json`,
      {
        method: "POST",
        headers: {
          Authorization: `Basic ${auth}`,
          "Content-Type": "application/x-www-form-urlencoded"
        },
        body: form.toString()
      }
    );

    const data = await response.json();

    if (!response.ok) {
      return {
        success: false,
        error:
          data.message ||
          "Twilio template request failed",
        code: data.code || null
      };
    }

    return {
      success: true,
      sid: data.sid,
      status: data.status
    };

  } catch (error) {
    return {
      success: false,
      error: error.message
    };
  }
}


/* =========================================================
   SEND WHATSAPP NOW + LOG RESULT
   الرسائل التشغيلية الحالية للنظام
   ========================================================= */

export async function sendWhatsAppNow({
  to,
  message,
  roundId,
  department,
  recipientName,
  reminderType
}) {

  const logRow = {
    round_id: roundId || "—",
    department: department || null,
    recipient_name: recipientName || null,
    recipient_phone: to,
    reminder_type: reminderType,
    message,
    event_key: null,
    status: "pending",
    attempts: 1,
    scheduled_at: new Date().toISOString()
  };

  const result = await sendTwilioMessageRaw({
    to,
    message
  });

  if (!result.success) {

    logRow.status = "failed";
    logRow.error_message = result.error;

    await sbInsert(
      "whatsapp_reminders",
      [logRow],
      "minimal"
    ).catch(() => {});

    return result;
  }

  logRow.status = "sent";
  logRow.sent_at = new Date().toISOString();
  logRow.twilio_message_sid = result.sid;

  await sbInsert(
    "whatsapp_reminders",
    [logRow],
    "minimal"
  ).catch(() => {});

  return result;
}
