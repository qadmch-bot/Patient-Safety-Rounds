export default async function handler(req, res) {
  // Allow only GET/POST for testing and scheduled execution
  if (!["GET", "POST"].includes(req.method)) {
    return res.status(405).json({
      success: false,
      error: "Method not allowed"
    });
  }

  try {
    const {
      SUPABASE_URL,
      SUPABASE_SECRET_KEY,
      TWILIO_ACCOUNT_SID,
      TWILIO_AUTH_TOKEN,
      TWILIO_WHATSAPP_FROM
    } = process.env;

    if (!SUPABASE_URL || !SUPABASE_SECRET_KEY) {
      return res.status(500).json({
        success: false,
        error: "Supabase environment variables are missing."
      });
    }

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

    const headers = {
      apikey: SUPABASE_SECRET_KEY,
      Authorization: `Bearer ${SUPABASE_SECRET_KEY}`,
      "Content-Type": "application/json"
    };

    const now = new Date().toISOString();

    // Get reminders that are due and still pending
    const remindersResponse = await fetch(
      `${SUPABASE_URL}/rest/v1/whatsapp_reminders` +
      `?status=eq.pending` +
      `&scheduled_at=lte.${encodeURIComponent(now)}` +
      `&order=scheduled_at.asc` +
      `&limit=20`,
      {
        method: "GET",
        headers
      }
    );

    if (!remindersResponse.ok) {
      const errorText = await remindersResponse.text();

      return res.status(500).json({
        success: false,
        error: "Unable to read reminders from Supabase.",
        details: errorText
      });
    }

    const reminders = await remindersResponse.json();

    if (!reminders.length) {
      return res.status(200).json({
        success: true,
        processed: 0,
        message: "No reminders are due."
      });
    }

    const results = [];

    for (const reminder of reminders) {
      try {
        let to = reminder.recipient_phone;

        if (!to.startsWith("whatsapp:")) {
          to = `whatsapp:${to}`;
        }

        let from = TWILIO_WHATSAPP_FROM;

        if (!from.startsWith("whatsapp:")) {
          from = `whatsapp:${from}`;
        }

        // Mark as processing first
        await fetch(
          `${SUPABASE_URL}/rest/v1/whatsapp_reminders?id=eq.${reminder.id}`,
          {
            method: "PATCH",
            headers,
            body: JSON.stringify({
              status: "processing",
              processing_at: new Date().toISOString(),
              attempts: (reminder.attempts || 0) + 1,
              updated_at: new Date().toISOString()
            })
          }
        );

        const form = new URLSearchParams();

        form.append("From", from);
        form.append("To", to);
        form.append(
          "Body",
          reminder.message ||
            "تذكير بجولة سلامة المرضى - Maternity & Children Hospital."
        );

        const auth = Buffer.from(
          `${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`
        ).toString("base64");

        const twilioResponse = await fetch(
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

        const twilioData = await twilioResponse.json();

        if (!twilioResponse.ok) {
          await fetch(
            `${SUPABASE_URL}/rest/v1/whatsapp_reminders?id=eq.${reminder.id}`,
            {
              method: "PATCH",
              headers,
              body: JSON.stringify({
                status: "failed",
                error_message:
                  twilioData.message || "Twilio request failed",
                updated_at: new Date().toISOString()
              })
            }
          );

          results.push({
            id: reminder.id,
            success: false,
            error: twilioData.message || "Twilio request failed"
          });

          continue;
        }

        // Message accepted by Twilio
        await fetch(
          `${SUPABASE_URL}/rest/v1/whatsapp_reminders?id=eq.${reminder.id}`,
          {
            method: "PATCH",
            headers,
            body: JSON.stringify({
              status: "sent",
              sent_at: new Date().toISOString(),
              twilio_message_sid: twilioData.sid,
              error_message: null,
              updated_at: new Date().toISOString()
            })
          }
        );

        results.push({
          id: reminder.id,
          success: true,
          sid: twilioData.sid,
          status: twilioData.status
        });

      } catch (error) {
        console.error("Reminder processing error:", error);

        results.push({
          id: reminder.id,
          success: false,
          error: error.message
        });
      }
    }

    return res.status(200).json({
      success: true,
      processed: reminders.length,
      results
    });

  } catch (error) {
    console.error("Process reminders error:", error);

    return res.status(500).json({
      success: false,
      error: "Internal server error"
    });
  }
}
