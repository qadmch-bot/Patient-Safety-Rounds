import { sbInsert } from "./supabase.js";

// Pure Twilio call — no logging, no table writes. Returns the true result
// either way. Shared by sendWhatsAppNow() (below, used by the automatic
// reminder/plan workflow — unchanged) and by api/whatsapp-manual-send.js
// (the new manual-send feature), so there is exactly one place that ever
// talks to Twilio.
export async function sendTwilioMessageRaw({ to, message }) {
  const { TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_WHATSAPP_FROM } = process.env;

  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_WHATSAPP_FROM) {
    return { success: false, error: "Twilio environment variables are missing." };
  }
  if (!to) {
    return { success: false, error: "Recipient has no mobile number." };
  }

  try {
    const toAddr = to.startsWith("whatsapp:") ? to : `whatsapp:${to}`;
    const fromAddr = TWILIO_WHATSAPP_FROM.startsWith("whatsapp:") ? TWILIO_WHATSAPP_FROM : `whatsapp:${TWILIO_WHATSAPP_FROM}`;

    const form = new URLSearchParams();
    form.append("From", fromAddr);
    form.append("To", toAddr);
    form.append("Body", message);

    const auth = Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString("base64");
    const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json`, {
      method: "POST",
      headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    });
    const data = await response.json();

    if (!response.ok) {
      return { success: false, error: data.message || "Twilio request failed" };
    }
    // Twilio's initial API response only ever reports queued/sent/failed at
    // this point — "delivered"/"read" require a status-callback webhook,
    // which is not implemented here. Never fabricate those two states.
    return { success: true, sid: data.sid, status: data.status };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

// Sends ONE WhatsApp message immediately via Twilio and logs the real
// outcome into whatsapp_reminders so it shows up in the existing WhatsApp
// Notification Log and dashboards. Never logs "Sent" unless Twilio
// actually accepted it. Used for event-triggered messages (plan request,
// plan returned for revision, evidence requested, daily due/overdue
// reminders) as opposed to manual sends, which log to
// whatsapp_manual_messages instead (see api/whatsapp-manual-send.js).
export async function sendWhatsAppNow({ to, message, roundId, department, recipientName, reminderType }) {
  const logRow = {
    round_id: roundId || "—",
    department: department || null,
    recipient_name: recipientName || null,
    recipient_phone: to,
    reminder_type: reminderType,
    message,
    event_key: null, // event-triggered sends are not part of the 24h/1h de-dup scheme
    status: "pending",
    attempts: 1,
    scheduled_at: new Date().toISOString(),
  };

  const result = await sendTwilioMessageRaw({ to, message });

  if (!result.success) {
    logRow.status = "failed";
    logRow.error_message = result.error;
    await sbInsert("whatsapp_reminders", [logRow], "minimal").catch(() => {});
    return result;
  }

  logRow.status = "sent";
  logRow.sent_at = new Date().toISOString();
  logRow.twilio_message_sid = result.sid;
  await sbInsert("whatsapp_reminders", [logRow], "minimal").catch(() => {});
  return result;
}
