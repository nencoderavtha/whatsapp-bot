# Manduva - Client Specific Requirements

---

## 1. General & Core Requirements

1. **Role-Based Dashboards**: Provide separate, customized dashboards for:
   - **Restaurant Owner**
   - **Restaurant Employee**

2. **Menu Database Integration**: Import latest menu items into the database from shared references:
   - Google Drive Folder 1: [Suraj Zomato Hyderabad - Folder 1](https://drive.google.com/drive/folders/1e0CcttefSR0zjjyw1U8t2nrv4fWsNyNE?usp=drive_link)
   - Google Drive Folder 2: [Suraj Zomato Hyderabad - Folder 2](https://drive.google.com/drive/folders/1ij8NWQLsEnNSb9bnegIwSflSv17J6FcB)
   - Local Menu Sheet: `MANDUVA_MENU-1.xlsx`

3. **Welcome Message**: Update custom WhatsApp welcome message for the restaurant.

4. **Daily Token Resets**: Order token numbers must reset daily (starts at **Order #1** every day instead of continuous incrementing).

5. **Out-of-Stock Item Handling (Post-Payment)**:
   - If an order is paid but an item is out of stock in the kitchen:
     - Employee can easily navigate to the customer chat directly from the order.
     - Propose alternative available items for replacement or initiate refund.
     - Support **automated refunds via Razorpay**.

---

## 2. Restaurant Employee Dashboard Requirements

### Overview of Navigation Tabs
* **Orders**
* **Chats**
* **Menu**
* **Application Settings**

---

### Tab-Wise Details

#### A. Orders Tab
* **Search & Filtering**: Search orders by Customer Name, Order ID, or Order Type (*Delivery*, *Walk-in*).
* **3-State Order Lifecycle**:
  1. **Current Orders**: All fresh incoming orders land here.
     - *Accept Button*: Moves order to processing.
     - *Dispatch Button*: Triggers delivery service to fetch riders.
  2. **Dispatched**: Automatically moves here once a delivery rider picks up the order.
  3. **Delivered**: Automatically updates once delivery is completed.
* **Order Rejection & Cancellation**:
  - Replace generic cancel button with **Reject / Refund** option.
  - Move cancellation option into a sub-menu with confirmation prompt to prevent accidental clicks.
  - Integrate **automated refund processing**.
* **Order UI & Detail Split**:
  - Clean, clutter-free detailed view.
  - Clear cost split: **Delivery Fee** + **Order Value**.
  - One-click jump to customer chat window.
  - Ensure order tracking link is functioning and accurate.

#### B. Chats Tab
* **Human Handoff Filter**: Dedicated section/filter for human handoff chats to quickly resolve customer support issues.
* **Search Navigation**: Search functionality within customer chats.

#### C. Menu Tab
* **Latest Items**: Populated with menu items from the Manduva menu Excel sheet.
* **Simplified Employee Controls**:
  - Remove options to add, edit, or delete menu items.
  - Employee controls restricted **only** to toggling item availability (**ON / OFF** switch).

#### D. Application Settings Tab
* **Theme Selection**: Toggle between Dark Mode and Light Mode.
* **Audio Notifications**: Custom order alert sound selection.

---

## 3. Restaurant Owner Dashboard Requirements

1. **Daily Analytics**: Full per-day statistics and order metrics.
2. **Customer Issues Tracking**: Overview of customer complaints and escalations.
3. **Campaign Management (Broadcasts)**:
   - Send custom broadcast announcements (e.g., *"Restaurant is open now"*, *"Ready for orders"*, *"Closing soon"*).
   - Target default or segmented customer lists.
   - Attach media assets (images, videos, attachments) to campaign messages.
4. **Financial Cost Split**:
   - Detailed revenue breakdown separating **Total Delivery Fees** vs **Order Values**.
   - Filterable by **Day**, **Selected Week**, or **Selected Month**.
5. **Customer Support Monitoring**:
   - View customer chat histories and open handoff issues.
   - Display resolution status and employee attribution (e.g., *"Resolved by [Employee Name]"*).
6. **Customer Relationship Management (CRM)**:
   - Filter customer database by order count, total spend, etc.
   - Add, edit, or delete customer records.
   - Add targeted customers directly to broadcast campaigns.
7. **Settings & Configuration**:
   - Payment gateway configurations.
   - Restaurant metadata management.
   - Emergency contact numbers (for real-time alert notifications & customer issue escalations).