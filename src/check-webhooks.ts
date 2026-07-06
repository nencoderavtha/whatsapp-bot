import { config } from "./config.js";

async function main() {
  const apiKey = config.kapso.apiKey;
  if (!apiKey) {
    console.error("No Kapso API key found in config!");
    return;
  }

  console.log("Fetching webhooks from Kapso...");
  const res = await fetch("https://api.kapso.ai/platform/v1/whatsapp/webhooks", {
    headers: {
      "X-API-Key": apiKey
    }
  });

  if (!res.ok) {
    console.error(`Kapso API error: ${res.status} ${res.statusText}`);
    const text = await res.text();
    console.error(text);
    return;
  }

  const data = await res.json();
  console.log("REGISTERED WEBHOOKS:");
  console.log(JSON.stringify(data, null, 2));
}

main().catch(console.error);
