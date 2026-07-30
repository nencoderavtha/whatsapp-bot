import axios from "axios";

async function main() {
  const payload = {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "12345", // WABA ID
        changes: [
          {
            value: {
              messaging_product: "whatsapp",
              metadata: {
                display_phone_number: "917989100512",
                phone_number_id: "1289755687544822"
              },
              contacts: [
                {
                  profile: { name: "Shivateja" },
                  wa_id: "919398449524"
                }
              ],
              messages: [
                {
                  from: "919398449524",
                  id: "wamid.HBgMOTE5Mzk4NDQ5NTI0FQIAEhgUM0EBMEJDNTk4MEFDMDQ5RDIzQwA=",
                  timestamp: Math.floor(Date.now() / 1000).toString(),
                  text: { body: "hi" },
                  type: "text"
                }
              ]
            },
            field: "messages"
          }
        ]
      }
    ]
  };

  try {
    const res = await axios.post("http://localhost:4000/webhook", payload);
    console.log("Webhook sent:", res.status);
  } catch (e: any) {
    console.error("Webhook error:", e.message);
  }
}

main().catch(console.error);
