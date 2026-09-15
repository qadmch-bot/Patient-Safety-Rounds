import { sbInsert } from "./supabase.js";

// Sends ONE WhatsApp message immediately via the real Twilio API (same call
// shape as the existing api/send-whatsapp.js) and logs the real outcome into
// whatsapp_reminders so it shows up in the existing WhatsApp Notification Log
// and dashboards. Never logs "Sent" unless Twilio actually accepted it.
//
// Used for event-triggered messages (plan request, plan returned for
// revision, evidence requested, etc.) as opposed to the time-scheduled
// 24h/1h round reminders, which go through the pending-queue + cron path.
export async function sendWhatsAppNow({ to, message, roundId, department, recipientName, reminderType }) {
  const { TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_WHATSAPP_FROM } = process.env;

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

  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_WHATSAPP_FROM || !to) {
    logRow.status = "failed";
    logRow.error_message = !to ? "Recipient has no saved mobile number." : "Twilio environment variables are missing.";
    await sbInsert("whatsapp_reminders", [logRow], "minimal").catch(() => {});
    return { success: false, error: logRow.error_message };
  }

  try {
    let toAddr = to.startsWith("whatsapp:") ? to : `whatsapp:${to}`;
    let fromAddr = TWILIO_WHATSAPP_FROM.startsWith("whatsapp:") ? TWILIO_WHATSAPP_FROM : `whatsapp:${TWILIO_WHATSAPP_FROM}`;

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
      logRow.status = "failed";
      logRow.error_message = data.message || "Twilio request failed";
      await sbInsert("whatsapp_reminders", [logRow], "minimal").catch(() => {});
      return { success: false, error: logRow.error_message };
    }

    logRow.status = "sent";
    logRow.sent_at = new Date().toISOString();
    logRow.twilio_message_sid = data.sid;
    await sbInsert("whatsapp_reminders", [logRow], "minimal").catch(() => {});
    return { success: true, sid: data.sid, status: data.status };
  } catch (error) {
    logRow.status = "failed";
    logRow.error_message = error.message;
    await sbInsert("whatsapp_reminders", [logRow], "minimal").catch(() => {});
    return { success: false, error: error.message };
  }
}
