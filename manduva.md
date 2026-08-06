# Manduva - Client Specific Requirements

---

## 1. General & Core Requirements

1. **Role-Based Dashboards**: Provide separate, customized dashboards with distinct permission levels:
   - **Restaurant Owner Dashboard** (Full admin controls, metrics, health status, and bot pause/resume)
   - **Restaurant Employee Dashboard** (Operational controls only; simplified menu & order management)

2. **Menu Database Integration**: Import and structure latest menu items in the database from shared references:
   - Google Drive Folder 1: [Suraj Zomato Hyderabad - Folder 1](https://drive.google.com/drive/folders/1e0CcttefSR0zjjyw1U8t2nrv4fWsNyNE?usp=drive_link)
   - Google Drive Folder 2: [Suraj Zomato Hyderabad - Folder 2](https://drive.google.com/drive/folders/1ij8NWQLsEnNSb9bnegIwSflSv17J6FcB)
   - Local Menu Sheet: `MANDUVA_MENU-1.xlsx`

3. **Welcome Message & Links**:
   - **Enhanced Welcome Message**: Redesign WhatsApp bot welcome message matching provided reference mockup.
   - **In-App Browser Integration**: Ensure links (catalog, web views, order tracking) open smoothly using WhatsApp's built-in in-app browser.

4. **Daily Token Resets**: Order token numbers must reset daily (starts at **Order #1** at the beginning of each day instead of continuous sequential numbers).

5. **Out-of-Stock Item Handling (Post-Payment)**:
   - If an order is paid but an item becomes unavailable in the kitchen:
     - Employee can click directly from the order to open customer WhatsApp chat.
     - Propose item replacement or initiate refund.
     - Support **automated refunds via Razorpay**.

6. **Alert & Notification System**:
   - Ensure real-time alerts and notifications sent to the restaurant owner and emergency contact numbers (for critical customer issues, new orders, escalations) are fully functional and reliable.

7. **Tracking & Observability**:
   - Improve bot system logging, performance metrics, and health check probes.

---

## 2. Restaurant Employee Dashboard Requirements

### Overview of Navigation Tabs
* **Orders**
* **Chats**
* **Menu**
* **Application Settings**

> [!IMPORTANT]
> **Employee Permission Restriction**: Remove "Pause Bot" and "Reset Options" from the Employee Dashboard to prevent accidental bot shutdown or state resets by kitchen staff.

---

### Tab-Wise Details

#### A. Orders Tab
* **Search & Filtering**: Search orders by Customer Name, Order ID, or Order Type (*Delivery*, *Walk-in*).
* **3-State Order Lifecycle**:
  1. **Current Orders**: All fresh incoming orders land here.
     - *Accept Button*: Moves order to active preparation.
     - *Dispatch Button*: Triggers delivery service integration to fetch riders.
  2. **Dispatched**: Automatically moves here once a delivery rider picks up the order.
  3. **Delivered**: Automatically updates once delivery is completed.
* **Order Rejection & Cancellation**:
  - Replace generic cancel button with **Reject / Refund** option.
  - Place cancellation option inside a dropdown/sub-menu with a confirmation dialog.
  - Integrated **automated refund processing via Razorpay**.
* **Order Details Breakdown**:
  - Clean, uncluttered UI layout.
  - Clear price breakdown: **Delivery Fee** + **Order Value**.
  - One-click shortcut button to jump directly to the customer's chat window.
  - Verify delivery tracking link is accurate and functional.

#### B. Chats Tab
* **Human Handoff Filter**: Dedicated tab/filter for customer support handoff chats for quick issue resolution.
* **Search Navigation**: Search bar to easily locate specific customer conversations.

#### C. Menu Tab
* **Latest Items**: Populated with menu items from the Manduva Excel sheet.
* **Simplified Employee Controls**:
  - Remove options to add, edit, or delete menu items.
  - Employee permissions limited strictly to **Toggle Availability (ON / OFF)** switches per item.

#### D. Application Settings Tab
* **Theme Selection**: Switch between Dark Mode and Light Mode.
* **Audio Notifications**: Custom order alert chime selection.

---

## 3. Restaurant Owner Dashboard Requirements

### Overview of Navigation Tabs & Features
* **Analytics & Performance**
* **Order & Cost Split Breakdown**
* **Customer Management (CRM) & Support Monitoring**
* **Campaigns (Broadcasts)**
* **Bot Health & System Logs** *(NEW)*
* **Settings & Exter-AI Support** *(NEW)*

---

### Key Owner Features

1. **Bot Health & System Monitoring (NEW Tab)**:
   - Dedicated **Bot Health** tab displaying live bot status, uptime, latency, and system logs.
   - Comprehensive error tracking and execution performance logs.

2. **Bot Control**:
   - **Pause / Resume Bot** toggle available **exclusively** on the Owner Dashboard.

3. **Exter-AI Support Integration (NEW)**:
   - Added **Contact Exter-AI** support link/button directly on the Owner Page for quick technical assistance.

4. **Daily Analytics & Cost Breakdown**:
   - Full daily order volume, revenue, and customer issue metrics.
   - Financial split view separating **Total Delivery Fees** vs **Order Values** (Filterable by **Day**, **Week**, or **Month**).

5. **Campaign Management (Broadcasts)**:
   - Create and schedule broadcast messages (*"Restaurant is Open"*, *"Taking Orders"*, *"Closing Soon"*).
   - Support rich media attachments (images/banners).
   - Target full or segmented customer lists.

6. **Customer CRM & Support Monitoring**:
   - View customer chat histories and open human handoff requests.
   - Resolution logs with staff attribution (*"Resolved by [Employee Name]"*).
   - Customer management: add/edit/delete customer records and assign to campaigns based on order frequency or spend.

7. **Settings & Configurations**:
   - Payment gateway parameters (Razorpay).
   - Restaurant metadata.
   - Emergency contact numbers for instant notification alerts.