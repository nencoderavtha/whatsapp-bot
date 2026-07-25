# 📚 Database Dictionary & Schema Guide

This document serves as the complete technical dictionary for the **Godavari Ruchulu** single-restaurant WhatsApp Bot database.

---

## 🏬 Module 1: Restaurant Configuration (`RestaurantConfig`)
Stores restaurant identity, operating hours, delivery auto-dispatch rules, payment credentials, and loyalty program parameters.

| Column | Data Type | Constraint / Default | Description |
| :--- | :--- | :--- | :--- |
| `id` | `Int` | `@id @default(1)` | Primary Key (fixed to `1` for single-restaurant deployment). |
| `restaurantName` | `String` | `"Godavari Ruchulu"` | Display name of the restaurant. |
| `restaurantCity` | `String` | `"Hyderabad"` | Restaurant city. |
| `restaurantAddress` | `String` | Default Address | Pickup location address sent to delivery riders. |
| `restaurantLat` | `Float?` | Optional | Latitude coordinate for delivery distance calculations. |
| `restaurantLng` | `Float?` | Optional | Longitude coordinate for delivery distance calculations. |
| `personaName` | `String?` | `"Rajamma"` | AI persona name spoken by the WhatsApp bot. |
| `ownerNumbers` | `String` | `""` | Comma-separated owner phone numbers for instant WhatsApp order notifications. |
| `isActive` | `Boolean` | `true` | Master switch to turn the bot application ON or OFF. |
| `dashboardPassword` | `String` | `"changeme"` | Staff login password for the admin web dashboard. |
| `loginUsername` | `String?` | `@unique` | Staff login username. |
| `botPaused` | `Boolean` | `false` | Emergency AI pause toggle (when true, staff handle chats manually). |
| `pauseMessage` | `String?` | Optional | Custom message sent to customers when bot is paused. |
| `whatsappPhone` | `String?` | Optional | Restaurant WhatsApp Business phone number. |
| `cloudPhoneNumberId` | `String?` | Optional | Meta Cloud API Phone Number ID. |
| `cloudToken` | `String?` | Optional | Permanent Meta Cloud API Access Token. |
| `requiresPaymentBeforeOrder`| `Boolean` | `false` | If true, order is marked `pending_payment` until payment completes. |
| `upiId` | `String?` | Optional | Restaurant UPI Virtual Payment Address (e.g. `godavari@ybl`). |
| `paymentMethods` | `String` | `"cash,upi,online"` | Allowed payment methods. |
| `razorpayEnabled` | `Boolean` | `false` | Enable/disable Razorpay online payment gateway. |
| `razorpayKeyId` | `String?` | Optional | Razorpay API Key ID. |
| `razorpayKeySecret` | `String?` | Optional | Razorpay API Key Secret. |
| `razorpayWebhookSecret`| `String?` | Optional | Razorpay Webhook Secret for automated verification. |
| `autoDispatchDelivery` | `Boolean` | `true` | Auto-dispatches orders to the best delivery partner (Rapido, Dunzo, etc.). |
| `defaultDeliveryStrategy`|`String` | `"CHEAPEST"` | Selection strategy: `"CHEAPEST"`, `"FASTEST"`, or `"BALANCED"`. |
| `loyaltyEarnRateRupees`| `Float` | `100.0` | Rupees spent to earn 1 loyalty point (₹100 = 1 pt). |
| `loyaltyRedeemValueRupees`|`Float` | `1.0` | Discount value per point redeemed (1 pt = ₹1 off). |
| `minPointsToRedeem` | `Int` | `50` | Minimum points threshold required before redeeming. |
| `updatedAt` | `DateTime` | `@updatedAt` | Timestamp of last configuration edit. |

---

## 🍽️ Module 2: Menu Catalog & Recommendations

### Table: `Category`
Categories for organizing dishes.

| Column | Data Type | Constraint / Default | Description |
| :--- | :--- | :--- | :--- |
| `id` | `Int` | `@id @default(autoincrement())` | Primary Key. |
| `name` | `String` | `@unique` | Category name (e.g. *"Biryanis"*, *"Starters"*). |
| `sortOrder` | `Int` | `0` | Sequence order in menu list. |

### Table: `MenuItem`
Individual dishes.

| Column | Data Type | Constraint / Default | Description |
| :--- | :--- | :--- | :--- |
| `id` | `Int` | `@id @default(autoincrement())` | Primary Key. |
| `name` | `String` | Required | Dish name (e.g. *"Chicken Fry Piece Biryani"*). |
| `description` | `String?` | Optional | Ingredients, flavor profile, and preparation notes. |
| `price` | `Float` | Required | Base price in ₹ (ignored if variants exist). |
| `available` | `Boolean` | `true` | Availability toggle. |
| `stockCount` | `Int?` | Optional | Inventory count (`null` = unlimited, `0` = sold out, `>0` = count). |
| `isVeg` | `Boolean` | `false` | Vegetarian flag (`true` = Veg 🟢, `false` = Non-Veg 🔴). |
| `spiceLevel` | `String?` | Optional | Spice rating (`"Mild"`, `"Medium"`, `"Spicy"`). |
| `sortOrder` | `Int` | `0` | Daily menu item number printed for customers. |
| `pieceInfo` | `String?` | Optional | Portion size info (e.g. *"2 pieces"*, *"Serves 1-2"*). |
| `imageUrl` | `String?` | Optional | Supabase storage image URL for dish photo. |
| `categoryId` | `Int` | FK $\rightarrow$ `Category.id` | Link to parent Category. |
| `createdAt` | `DateTime` | `@default(now())` | Record creation timestamp. |
| `updatedAt` | `DateTime` | `@updatedAt` | Last update timestamp. |

### Table: `MenuItemVariant`
Size variations for a dish.

| Column | Data Type | Constraint / Default | Description |
| :--- | :--- | :--- | :--- |
| `id` | `Int` | `@id @default(autoincrement())` | Primary Key. |
| `menuItemId` | `Int` | FK $\rightarrow$ `MenuItem.id` | Link to parent MenuItem. |
| `name` | `String` | Required | Variant name (e.g. *"Half"*, *"Full"*, *"Family Pack"*). |
| `price` | `Float` | Required | Variant price in ₹. |
| `available` | `Boolean` | `true` | Variant availability status. |
| `sortOrder` | `Int` | `0` | Sort sequence. |

### Table: `ItemRecommendation`
Cross-sell rules for AI upsells.

| Column | Data Type | Constraint / Default | Description |
| :--- | :--- | :--- | :--- |
| `id` | `Int` | `@id @default(autoincrement())` | Primary Key. |
| `menuItemId` | `Int` | FK $\rightarrow$ `MenuItem.id` | Primary dish ordered. |
| `recommendedItemId`| `Int` | FK $\rightarrow$ `MenuItem.id` | Suggested pairing dish (e.g. *Thumbs Up*). |
| `pitchMessage` | `String?` | Optional | Upsell message spoken by AI. |

---

## 👤 Module 3: Customer Profiles & Chat Memory

### Table: `Customer`
Customer CRM profiles.

| Column | Data Type | Constraint / Default | Description |
| :--- | :--- | :--- | :--- |
| `id` | `Int` | `@id @default(autoincrement())` | Primary Key. |
| `phone` | `String` | `@unique` | Customer WhatsApp phone number. |
| `name` | `String?` | Optional | Customer name. |
| `address` | `String?` | Optional | Saved default delivery address. |
| `deliveryLat` | `Float?` | Optional | Latitude for exact delivery dropoff location. |
| `deliveryLng` | `Float?` | Optional | Longitude for exact delivery dropoff location. |
| `favoriteDish` | `String?` | Optional | Frequently ordered dish tag. |
| `dietaryPreference`| `String?` | Optional | Dietary tag (`"veg"`, `"non_veg"`). |
| `notes` | `String?` | Optional | Special instructions/allergies noted by staff. |
| `humanRequestedAt`| `DateTime?`| Optional | Human handoff timestamp. AI pauses while non-null. |
| `totalOrdersCount`| `Int` | `0` | Counter of total completed orders. |
| `totalSpentRupees`| `Float` | `0.0` | Total lifetime spend in ₹. |
| `lastOrderedAt` | `DateTime?`| Optional | Timestamp of most recent order. |
| `createdAt` | `DateTime` | `@default(now())` | Registration timestamp. |

### Table: `Message`
Raw conversation history (30-day retention).

| Column | Data Type | Constraint / Default | Description |
| :--- | :--- | :--- | :--- |
| `id` | `Int` | `@id @default(autoincrement())` | Primary Key. |
| `customerId` | `Int` | FK $\rightarrow$ `Customer.id` | Link to Customer. |
| `role` | `String` | Required | Sender role (`"user"` = Customer, `"assistant"` = Bot/Staff). |
| `content` | `String` | Required | Message text content or Sarvam AI speech transcript. |
| `mediaType` | `String` | `"text"` | Content format (`"text"`, `"audio"`, `"image"`). |
| `mediaUrl` | `String?` | Optional | Supabase Storage URL for original voice recording / dish photo. |
| `createdAt` | `DateTime` | `@default(now())` | Timestamp for chat retention pruning. |

---

## 🛒 Module 4: Orders & Draft Carts

### Table: `Order`
Finalized customer orders.

| Column | Data Type | Constraint / Default | Description |
| :--- | :--- | :--- | :--- |
| `id` | `Int` | `@id @default(autoincrement())` | Primary Key (Order ID). |
| `customerId` | `Int` | FK $\rightarrow$ `Customer.id` | Link to Customer. |
| `status` | `String` | `"pending"` | Order lifecycle status (`pending`, `confirmed`, `preparing`, `ready`, `out_for_delivery`, `delivered`, `cancelled`). |
| `type` | `String` | `"pickup"` | Fulfillment type (`"pickup"`, `"delivery"`, `"dine-in"`). |
| `subtotal` | `Float` | `0` | Items subtotal in ₹ before discounts. |
| `discountTotal` | `Float` | `0` | Total savings in ₹ from coupons + loyalty. |
| `deliveryFee` | `Float` | `0` | Delivery charge added to order. |
| `loyaltyPointsApplied`| `Int` | `0` | Loyalty points redeemed. |
| `loyaltyDiscount` | `Float` | `0` | Rupees saved via loyalty points. |
| `couponCode` | `String?` | Optional | Promo code applied. |
| `total` | `Float` | `0` | Final payable total in ₹. |
| `deliveryAddress` | `String?` | Optional | Delivery address string. |
| `deliveryLat` | `Float?` | Optional | Delivery latitude. |
| `deliveryLng` | `Float?` | Optional | Delivery longitude. |
| `note` | `String?` | Optional | Kitchen instructions. |
| `createdAt` | `DateTime` | `@default(now())` | Placement timestamp. |
| `updatedAt` | `DateTime` | `@updatedAt` | Last update timestamp. |

### Table: `OrderItem`
Line items attached to an order.

| Column | Data Type | Constraint / Default | Description |
| :--- | :--- | :--- | :--- |
| `id` | `Int` | `@id @default(autoincrement())` | Primary Key. |
| `orderId` | `Int` | FK $\rightarrow$ `Order.id` | Parent order link. |
| `menuItemId` | `Int?` | FK $\rightarrow$ `MenuItem.id` | Original MenuItem link. |
| `variantId` | `Int?` | FK $\rightarrow$ `MenuItemVariant.id` | Original Variant link. |
| `nameSnap` | `String` | Required | Dish name snapshot at order time. |
| `variantSnap` | `String?` | Optional | Variant name snapshot (e.g. *"Full"*). |
| `priceSnap` | `Float` | Required | Unit price snapshot at order time. |
| `qty` | `Int` | `1` | Quantity ordered. |
| `note` | `String?` | Optional | Item customization note. |

### Table: `PendingOrder`
Draft shopping cart state.

| Column | Data Type | Constraint / Default | Description |
| :--- | :--- | :--- | :--- |
| `id` | `Int` | `@id @default(autoincrement())` | Primary Key. |
| `customerId` | `Int` | FK $\rightarrow$ `Customer.id` | 1-to-1 link to Customer. |
| `lines` | `String` | Required | JSON string of cart lines. |
| `type` | `String` | `"pickup"` | Delivery / pickup selection. |
| `note` | `String?` | Optional | Cart note. |
| `appliedCoupon` | `String?` | Optional | Applied coupon code. |
| `redeemedPoints` | `Int` | `0` | Points staged for redemption. |
| `confirmedOrderId` | `Int?` | Optional | Converted Order ID once placed. |
| `paymentMethod` | `String?` | Optional | Selected payment method (`"upi"`, `"cash"`). |
| `paymentReference` | `String?` | Optional | Payment transaction reference. |
| `razorpayLinkId` | `String?` | Optional | Razorpay payment link ID. |
| `razorpayLinkUrl` | `String?` | Optional | Razorpay payment URL. |
| `expiresAt` | `DateTime` | Required | Expiration timestamp (2 hours). |
| `updatedAt` | `DateTime` | `@updatedAt` | Last edit timestamp. |

---

## 🚚 Module 5: Multi-Provider Delivery Integration

### Table: `DeliveryProviderConfig`
Credentials and API settings for delivery services (Rapido, Dunzo, Shadowfax, Uber, Porter).

| Column | Data Type | Constraint / Default | Description |
| :--- | :--- | :--- | :--- |
| `id` | `Int` | `@id @default(autoincrement())` | Primary Key. |
| `providerCode` | `String` | `@unique` | Provider code (`"rapido"`, `"dunzo"`, `"shadowfax"`, `"uber"`, `"porter"`). |
| `providerName` | `String` | Required | Display name (e.g. *"Rapido Parcel"*). |
| `isEnabled` | `Boolean` | `true` | Enable/disable provider dispatch. |
| `apiKey` | `String?` | Optional | Provider API key. |
| `apiSecret` | `String?` | Optional | Provider API secret. |
| `merchantId` | `String?` | Optional | Provider merchant account ID. |
| `webhookSecret` | `String?` | Optional | Secret for verifying rider tracking webhooks. |
| `priorityWeight` | `Int` | `1` | Selection multiplier for quote prioritization. |
| `createdAt` | `DateTime` | `@default(now())` | Setup timestamp. |
| `updatedAt` | `DateTime` | `@updatedAt` | Edit timestamp. |

### Table: `DeliveryQuote`
Real-time quotes fetched from delivery services prior to dispatch.

| Column | Data Type | Constraint / Default | Description |
| :--- | :--- | :--- | :--- |
| `id` | `Int` | `@id @default(autoincrement())` | Primary Key. |
| `orderId` | `Int` | FK $\rightarrow$ `Order.id` | Linked order. |
| `providerCode` | `String` | Required | Provider code (`"rapido"`, `"dunzo"`, etc.). |
| `providerQuoteId` | `String?` | Optional | Quote ID issued by delivery provider API. |
| `quotedFee` | `Float` | Required | Delivery price quote in ₹. |
| `estimatedMinutes` | `Int` | Required | Estimated delivery duration in minutes. |
| `distanceKm` | `Float?` | Optional | Calculated distance in KM. |
| `isAvailable` | `Boolean` | `true` | Rider availability status reported by provider. |
| `expiresAt` | `DateTime` | Required | Quote expiration timestamp. |
| `isSelected` | `Boolean` | `false` | True if this quote was chosen for dispatch. |
| `createdAt` | `DateTime` | `@default(now())` | Fetch timestamp. |

### Table: `DeliveryDispatch`
Active delivery booking, rider information, and live GPS tracking.

| Column | Data Type | Constraint / Default | Description |
| :--- | :--- | :--- | :--- |
| `id` | `Int` | `@id @default(autoincrement())` | Primary Key. |
| `orderId` | `Int` | FK $\rightarrow$ `Order.id` | 1-to-1 link to Order. |
| `providerCode` | `String` | Required | Selected delivery service code. |
| `externalDeliveryId`| `String?` | Optional | Provider's waybill / booking reference ID. |
| `status` | `String` | `"SEARCHING_RIDER"` | Live status (`SEARCHING_RIDER`, `RIDER_ASSIGNED`, `PICKED_UP`, `IN_TRANSIT`, `DELIVERED`, `CANCELLED`, `FAILED`). |
| `deliveryFee` | `Float` | Required | Final delivery charge paid to provider in ₹. |
| `distanceKm` | `Float?` | Optional | Final distance in KM. |
| `estimatedMinutes` | `Int?` | Optional | ETA in minutes. |
| `riderName` | `String?` | Optional | Delivery agent name. |
| `riderPhone` | `String?` | Optional | Delivery agent contact phone number. |
| `riderVehicleNumber`| `String?` | Optional | Vehicle registration number (e.g. *"TS 07 EA 1234"*). |
| `riderLat` | `Float?` | Optional | Live GPS latitude coordinate. |
| `riderLng` | `Float?` | Optional | Live GPS longitude coordinate. |
| `trackingUrl` | `String?` | Optional | Customer live tracking web URL. |
| `waybillNumber` | `String?` | Optional | Shipping bill / receipt number. |
| `dispatchedAt` | `DateTime` | `@default(now())` | Dispatch booking timestamp. |
| `pickedUpAt` | `DateTime?` | Optional | Timestamp when rider picked up order from restaurant. |
| `deliveredAt` | `DateTime?` | Optional | Timestamp when order was delivered to customer. |
| `cancelledAt` | `DateTime?` | Optional | Cancellation timestamp. |
| `updatedAt` | `DateTime` | `@updatedAt` | Last status edit timestamp. |

---

## 💳 Module 6: Payments (`Payment`)

| Column | Data Type | Constraint / Default | Description |
| :--- | :--- | :--- | :--- |
| `id` | `Int` | `@id @default(autoincrement())` | Primary Key. |
| `orderId` | `Int` | FK $\rightarrow$ `Order.id` | 1-to-1 link to Order. |
| `status` | `String` | `"pending"` | Payment status (`"pending"`, `"paid"`, `"failed"`, `"refunded"`). |
| `method` | `String?` | Optional | Payment mode (`"upi"`, `"cash"`, `"razorpay"`). |
| `amount` | `Float` | Required | Payment amount in ₹. |
| `reference` | `String?` | Optional | Transaction UTR number or Razorpay payment ID. |
| `paidAt` | `DateTime?`| Optional | Verification timestamp. |
| `createdAt` | `DateTime` | `@default(now())` | Creation timestamp. |
| `updatedAt` | `DateTime` | `@updatedAt` | Edit timestamp. |

---

## 🎟️ Module 7: Coupons & Discounts

### Table: `Coupon`
Promo codes.

| Column | Data Type | Constraint / Default | Description |
| :--- | :--- | :--- | :--- |
| `id` | `Int` | `@id @default(autoincrement())` | Primary Key. |
| `code` | `String` | `@unique` | Coupon code (e.g. *"UGADI20"*). |
| `description` | `String?` | Optional | Customer description. |
| `discountType` | `String` | Required | Discount type (`"percentage"` vs `"fixed"`). |
| `discountValue` | `Float` | Required | Discount magnitude (`20` for 20% or `100` for ₹100). |
| `minOrderAmount`| `Float` | `0` | Minimum order subtotal required. |
| `maxDiscount` | `Float?` | Optional | Maximum discount cap in ₹ for percentage coupons. |
| `usageLimit` | `Int?` | Optional | Global usage ceiling. |
| `usedCount` | `Int` | `0` | Total redemptions so far. |
| `perUserLimit` | `Int` | `1` | Max redemptions allowed per customer. |
| `isActive` | `Boolean` | `true` | Active status toggle. |
| `startsAt` | `DateTime` | `@default(now())` | Effective start date. |
| `expiresAt` | `DateTime?`| Optional | Expiration date. |

### Table: `CouponRedemption`
Audit trail per redeemed coupon.

| Column | Data Type | Constraint / Default | Description |
| :--- | :--- | :--- | :--- |
| `id` | `Int` | `@id @default(autoincrement())` | Primary Key. |
| `couponId` | `Int` | FK $\rightarrow$ `Coupon.id` | Coupon link. |
| `customerId` | `Int` | FK $\rightarrow$ `Customer.id` | Customer link. |
| `orderId` | `Int` | FK $\rightarrow$ `Order.id` | Order link. |
| `discount` | `Float` | Required | Amount saved in ₹. |
| `redeemedAt` | `DateTime` | `@default(now())` | Redemption timestamp. |

---

## 🎁 Module 8: Loyalty Points Program

### Table: `LoyaltyAccount`

| Column | Data Type | Constraint / Default | Description |
| :--- | :--- | :--- | :--- |
| `id` | `Int` | `@id @default(autoincrement())` | Primary Key. |
| `customerId` | `Int` | FK $\rightarrow$ `Customer.id` | 1-to-1 link to Customer. |
| `pointBalance` | `Int` | `0` | Available spendable loyalty points. |
| `totalEarned` | `Int` | `0` | Total lifetime points earned. |
| `tier` | `String` | `"Silver"` | VIP Tier (`"Silver"`, `"Gold"`, `"Platinum"`). |
| `updatedAt` | `DateTime` | `@updatedAt` | Last edit timestamp. |

### Table: `LoyaltyTransaction`

| Column | Data Type | Constraint / Default | Description |
| :--- | :--- | :--- | :--- |
| `id` | `Int` | `@id @default(autoincrement())` | Primary Key. |
| `loyaltyAccountId`| `Int` | FK $\rightarrow$ `LoyaltyAccount.id` | Loyalty Account link. |
| `type` | `String` | Required | Transaction type (`"EARNED"`, `"REDEEMED"`, `"EXPIRED"`, `"BONUS"`). |
| `points` | `Int` | Required | Points delta (`+15` for earned, `-50` for redeemed). |
| `description` | `String` | Required | Description note. |
| `orderId` | `Int?` | Optional | Linked Order ID. |
| `createdAt` | `DateTime` | `@default(now())` | Transaction timestamp. |

---

## 📣 Module 9: Campaigns & Broadcast Marketing

### Table: `Campaign`

| Column | Data Type | Constraint / Default | Description |
| :--- | :--- | :--- | :--- |
| `id` | `Int` | `@id @default(autoincrement())` | Primary Key. |
| `title` | `String` | Required | Internal campaign title. |
| `messageText` | `String` | Required | WhatsApp template message content. |
| `imageUrl` | `String?` | Optional | Festival promo banner image. |
| `couponCode` | `String?` | Optional | Included coupon code. |
| `status` | `String` | `"draft"` | Campaign state (`"draft"`, `"scheduled"`, `"sending"`, `"completed"`). |
| `targetFilter` | `String` | `"all"` | Target segment (`"all"`, `"top_spenders"`, `"inactive_30d"`). |
| `scheduledAt` | `DateTime?`| Optional | Scheduled dispatch date/time. |
| `sentCount` | `Int` | `0` | Total messages dispatched. |

### Table: `CampaignRecipient`

| Column | Data Type | Constraint / Default | Description |
| :--- | :--- | :--- | :--- |
| `id` | `Int` | `@id @default(autoincrement())` | Primary Key. |
| `campaignId` | `Int` | FK $\rightarrow$ `Campaign.id` | Campaign link. |
| `customerId` | `Int` | FK $\rightarrow$ `Customer.id` | Customer link. |
| `status` | `String` | `"pending"` | Delivery status (`"pending"`, `"sent"`, `"failed"`). |
| `sentAt` | `DateTime?`| Optional | Send timestamp. |

---

## ⏰ Module 10: Automated Tasks & Observability

### Table: `FollowupTask`

| Column | Data Type | Constraint / Default | Description |
| :--- | :--- | :--- | :--- |
| `id` | `Int` | `@id @default(autoincrement())` | Primary Key. |
| `type` | `String` | Required | Task type (`"ABANDONED_CART"`, `"FEEDBACK_REQUEST"`, `"REORDER_NUDGE"`). |
| `customerId` | `Int` | FK $\rightarrow$ `Customer.id` | Customer link. |
| `meta` | `String?` | Optional | JSON payload metadata. |
| `status` | `String` | `"pending"` | Task state (`"pending"`, `"executed"`, `"cancelled"`, `"failed"`). |
| `executeAt` | `DateTime` | Required | Execution scheduled timestamp. |

### Table: `ActivityLog`

| Column | Data Type | Constraint / Default | Description |
| :--- | :--- | :--- | :--- |
| `id` | `Int` | `@id @default(autoincrement())` | Primary Key. |
| `type` | `String` | Required | Event type (`"response_time"`, `"tool_error"`, `"fallback"`, `"human_handoff"`). |
| `message` | `String` | Required | Human readable log text. |
| `meta` | `String?` | Optional | JSON metadata. |
| `customerId` | `Int?` | Optional | Linked customer. |
| `createdAt` | `DateTime` | `@default(now())` | Log timestamp. |

### Table: `ToolDefinition`

| Column | Data Type | Constraint / Default | Description |
| :--- | :--- | :--- | :--- |
| `id` | `Int` | `@id @default(autoincrement())` | Primary Key. |
| `name` | `String` | `@unique` | Tool function name (e.g. `"check_order_status"`). |
| `description` | `String` | Required | Description telling LLM when to invoke tool. |
| `parametersSchema`| `String` | Required | JSON Schema defining function arguments. |
| `isEnabled` | `Boolean` | `true` | Active status toggle. |
| `sortOrder` | `Int` | `0` | Tool priority sequence. |
