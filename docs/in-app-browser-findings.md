# WhatsApp In-App Browser Integration — Technical Findings & Reference Guide

This document captures empirical findings, platform behavior rules, Meta Graph API specifications, and configuration requirements for opening external web links inside WhatsApp's In-App Browser.

---

## 1. Executive Summary

- **In-App Webview Support**: WhatsApp supports opening web links inside an In-App Browser overlay (sliding up over the chat timeline) when using **Interactive CTA URL Buttons** (`type: "cta_url"`).
- **Approved WABA Requirement**: In-app webview rendering requires sending messages from an **Approved Meta Business Account (WABA)**. Meta Developer Console test numbers delegate links to external browsers (Chrome/Safari) by default.
- **Domain Requirements**: The target URL must be a clean **HTTPS** domain without security warning landing pages (e.g. ngrok free warning interstitials force external browser redirects).
- **Graph API Version**: Must use Meta Graph API **`v24.0`** (`https://graph.facebook.com/v24.0/...`).

---

## 2. Meta Graph API `cta_url` Payload Specification

To trigger WhatsApp's In-App Browser on supported client devices, send the following interactive message payload:

### Meta Graph API Request Endpoint
```http
POST https://graph.facebook.com/v24.0/{phone_number_id}/messages
Authorization: Bearer {access_token}
Content-Type: application/json
```

### Request Payload (`cta_url`)
```json
{
  "messaging_product": "whatsapp",
  "recipient_type": "individual",
  "to": "CUSTOMER_PHONE_NUMBER",
  "type": "interactive",
  "interactive": {
    "type": "cta_url",
    "body": {
      "text": "Check out our latest deals & web menu 👇"
    },
    "action": {
      "name": "cta_url",
      "parameters": {
        "display_text": "Visit website",
        "url": "https://your-production-domain.com/deals"
      }
    }
  }
}
```

---

## 3. Key Technical Findings & Platform Behaviors

### A. Approved Meta Business Account (WABA) vs Developer Test Numbers
* **Kapso Sandbox / Approved WABA (e.g. WABA ID `2102230076919824`)**:  
  Connected to an official Meta Business Partner WABA. Meta automatically enables native in-app webview sheet rendering for CTA URL buttons sent from approved accounts.
* **Developer Console Test Numbers (`1289755687544822`)**:  
  Temporary test numbers in Meta Developer Console have security restrictions that cause Meta to delegate URL actions to external browser intents (Chrome/Safari).

### B. Ngrok Tunnels vs Production HTTPS Domains
* **`*.ngrok-free.dev` Tunnels**:  
  Free ngrok tunnels append interstitial security landing pages (*"You are visiting an ngrok link..."*). WhatsApp detects the query redirect/warning page and forces the OS to launch full Chrome/Safari.
* **Production HTTPS SSL Domains**:  
  Clean production SSL domains (e.g. `https://orders.yourclient.com` or Cloud Run `https://*.run.app`) load directly into the in-app webview without redirection.

### C. 24-Hour Conversation Window Rule
* **Freeform Session Messages**:  
  Interactive `cta_url` messages require an **active 24-hour conversation session** (triggered when the customer sends an inbound message like `Hi` to the business number).
* **Outside 24-Hour Window**:  
  Outside the active window, freeform interactive messages return HTTP `422` (or are suppressed). Re-opening the session requires sending a pre-approved Meta WhatsApp Message Template (`type: "template"`).

### D. Device & Platform Rendering Matrix

| Client Device / Platform | Behavior on Tapping `cta_url` Button |
| :--- | :--- |
| **WhatsApp Mobile (iOS)** | Opens in **Safari View Controller Overlay** (slides up over chat). |
| **WhatsApp Mobile (Android)** | Opens in **Chrome Custom Tab Overlay** inside WhatsApp. |
| **WhatsApp Web (Desktop)** | `cta_url` buttons are suppressed/hidden by Meta (desktop cannot execute mobile CTA actions). |

---

## 4. Alternative Native In-App Solutions (Zero Redirection)

If you need a 100% native UI experience inside the WhatsApp chat timeline with **zero browser URL bar**:

1. **WhatsApp Interactive Lists (`type: "list"`)**:
   * Renders native selection lists directly inside the chat timeline (used in bot for address picking and menu categories).
2. **WhatsApp Quick Reply Buttons (`type: "button"`)**:
   * Action buttons attached directly to message bubbles inside the chat.
3. **Meta WhatsApp Flows (`type: "flow"`)**:
   * Meta's native form sheet framework that slides up from the bottom of WhatsApp without any browser top bar.

---

## 5. Code Implementation (`src/whatsapp/cloud.ts`)

```typescript
async sendInteractiveCtaUrl(
  phone: string,
  bodyText: string,
  buttonText: string,
  url: string,
): Promise<void> {
  await this.sendInteractive(phone, {
    type: "cta_url",
    body: { text: bodyText || "Tap below to open link in WhatsApp 👇" },
    action: {
      name: "cta_url",
      parameters: { display_text: buttonText.slice(0, 20), url },
    },
  });
}
```
