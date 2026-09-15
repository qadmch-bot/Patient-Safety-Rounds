// GET /api/whatsapp-status
//
// Verifies the configured Twilio credentials are valid by fetching the
// Twilio Account resource — this does NOT send any message, it is a pure
// connectivity/credential check, used by the "Test Connection" button.
// Replaces the previous whatsappBackendConnected() stub that always
// returned true without checking anything.

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ success: false, error: "Method not allowed" });

  const { TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_WHATSAPP_FROM, SUPABASE_URL, SUPABASE_SECRET_KEY } = process.env;

  const status = {
    twilio_configured: !!(TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN && TWILIO_WHATSAPP_FROM),
    supabase_configured: !!(SUPABASE_URL && SUPABASE_SECRET_KEY),
    twilio_reachable: false,
    error: null,
  };

  if (!status.twilio_configured) {
    status.error = "Twilio environment variables are missing.";
    return res.status(200).json({ success: false, ...status });
  }

  try {
    const auth = Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString("base64");
    const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}.json`, {
      headers: { Authorization: `Basic ${auth}` },
    });
    const data = await response.json();

    if (!response.ok) {
      status.error = data.message || `Twilio responded with status ${response.status}`;
      return res.status(200).json({ success: false, ...status });
    }

    status.twilio_reachable = true;
    status.account_status = data.status;
    status.account_friendly_name = data.friendly_name;
    return res.status(200).json({ success: true, ...status });
  } catch (error) {
    status.error = error.message;
    return res.status(200).json({ success: false, ...status });
  }
}
