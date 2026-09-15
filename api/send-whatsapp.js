export default async function handler(req, res) {
  // Allow the Patient Safety Rounds website to call this API
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({
      success: false,
      error: "Method not allowed"
    });
  }

  try {
    const {
      TWILIO_ACCOUNT_SID,
      TWILIO_AUTH_TOKEN,
      TWILIO_WHATSAPP_FROM,
      TWILIO_TEST_TO
    } = process.env;

    if (
      !TWILIO_ACCOUNT_SID ||
      !TWILIO_AUTH_TOKEN ||
      !TWILIO_WHATSAPP_FROM
    ) {
      return res.status(500).json({
        success: false,
        error: "Twilio environment variables are missing."
      });
    }

    const body = req.body || {};

    let to = body.to || TWILIO_TEST_TO;
    const message =
      body.message ||
      "اختبار نظام جولات سلامة المرضى - تم الاتصال بخدمة WhatsApp بنجاح.";

    if (!to) {
      return res.status(400).json({
        success: false,
        error: "Recipient number is required."
      });
    }

    // Normalize WhatsApp numbers
    if (!to.startsWith("whatsapp:")) {
      to = `whatsapp:${to}`;
    }

    let from = TWILIO_WHATSAPP_FROM;

    if (!from.startsWith("whatsapp:")) {
      from = `whatsapp:${from}`;
    }

    const form = new URLSearchParams();
    form.append("From", from);
    form.append("To", to);
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
      return res.status(response.status).json({
        success: false,
        error: data.message || "Twilio request failed",
        code: data.code || null
      });
    }

    return res.status(200).json({
      success: true,
      sid: data.sid,
      status: data.status,
      to: data.to,
      from: data.from
    });

  } catch (error) {
    console.error("WhatsApp API Error:", error);

    return res.status(500).json({
      success: false,
      error: "Internal server error"
    });
  }
}
