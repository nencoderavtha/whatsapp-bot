# Shiprocket Courier Master Reference Guide

This document serves as an authoritative reference for all Shiprocket courier IDs, service types, master companies, and API fields configured in your Shiprocket merchant account.

---

## 1. Service Types Breakdown

| `service_type` | Category | Description |
| :--- | :--- | :--- |
| **`3`** | **Hyperlocal / Quick / ONDC** | Express 2-wheeler, 3-wheeler, and ONDC instant delivery fleets (used for local food/item deliveries). |
| **`1`** | **Forward Shipping** | Standard B2C eCommerce courier shipping (Air & Surface). |
| **`2`** | **Reverse Logistics** | Return pickup logistics. |

---

## 2. Hyperlocal & Quick Couriers (`service_type: 3`)

These couriers are aggregated under **Shiprocket Quick** for instant local fulfillment:

| Courier ID (`id`) | Base Courier ID | Courier Name | Master Company | Category |
| :--- | :--- | :--- | :--- | :--- |
| **959** | 959 | Quick-Rapido | Quick-Rapido | 2-Wheeler Motorbike |
| **870** | 870 | Quick-Rapido 2WC | Quick-Rapido | 2-Wheeler Motorbike |
| **987** | 987 | Quick-Loadshare | Quick-Loadshare | 2-Wheeler Express |
| **15055** | 15055 | Quick-Loadshare 2W | Quick-Loadshare | 2-Wheeler Express |
| **881** | 881 | MagicFleet Quick | MagicFleet Quick | 2-Wheeler Express |
| **15052** | 15052 | Quick-Magic fleet 2W | Quick-Magic fleet 2W | 2-Wheeler Express |
| **874** | 874 | Quick 2W | Quick 2W | 2-Wheeler Generic |
| **876** | 876 | Quick 3W | Quick 3W | 3-Wheeler Loader |
| **878** | 878 | Quick 4W | Quick 4W | 4-Wheeler Mini Truck |
| **15080** | 15080 | Quick 4W | Quick 4W | 4-Wheeler Mini Truck |
| **877** | 877 | Quick Partner 3W | Quick Partner 3W | 3-Wheeler Loader |
| **811** | 811 | Quick-Flash 2WC | Quick-Flash 2WC | 2-Wheeler Express |
| **904** | 904 | Quick-Loadster 3W | Quick-Loadster 3W | 3-Wheeler Loader |
| **873** | 873 | Quick-Loadster 3WC | Quick-Loadster 3WC | 3-Wheeler Loader |
| **905** | 905 | Loadster 3W | Loadster 3W | 3-Wheeler Loader |
| **956** | 956 | Quick-Mover | Quick-Mover | Express Logistics |
| **941** | 941 | Quick-Mover 3W | Quick-Mover 3W | 3-Wheeler Loader |
| **944** | 944 | Mover 3W | Mover 3W | 3-Wheeler Loader |
| **954** | 954 | Quick-Qwqer | Quick-Qwqer | Local Express |
| **868** | 868 | PICO_EXPRESS_QUICK | PICO_EXPRESS_QUICK | Local Express |
| **890** | 890 | Bharat | Bharat | Local Express |
| **866** | 866 | Blitz ONDC | Blitz ONDC | ONDC Network |
| **15034** | 15034 | Bounce | Bounce | EV 2-Wheeler Fleet |
| **15081** | 15081 | GL-Express-ONDC | GL-Express-ONDC | ONDC Network |
| **15082** | 15082 | Shreeji-Enterprises-ONDC | Shreeji-Enterprises-ONDC | ONDC Network |
| **15110** | 15110 | Airxy-ONDC | Airxy-ONDC | ONDC Network |
| **15083** | 15083 | Rabbit-Delivery-ONDC | Rabbit-Delivery-ONDC | ONDC Network |

---

## 3. Forward Couriers (`service_type: 1`)

### Blue Dart
- `1`: Blue Dart Air
- `55`: Blue Dart Surface
- `604`: BlueDart Surface 2KG

### Delhivery
- `10`: Delhivery Air
- `43`: Delhivery Surface
- `44`: Delhivery Surface 2 Kgs
- `39`: Delhivery Surface 5kg
- `100`: Delhivery Surface 10kg
- `101`: Delhivery Surface 20kg

### Shadowfax
- `789`: Shadowfax Instant Express
- `252`: Instant pickup - Shadowfax
- `613`: Shadowfax Air
- `58`: Shadowfax Surface
- `614`: Shadowfax Surface 2Kg
- `765`: Shadowfax Heavy 5Kg
- `766`: Shadowfax Heavy 10Kg

### Ekart Logistics (Flipkart)
- `48`: Ekart Logistics Air
- `54`: Ekart Logistics Surface
- `170`: Ekart Surface 2kg
- `171`: Ekart Surface 5kg
- `851`: Ekart 5Kg New
- `130`: Ekart Surface 10kg
- `676`: Ekart 10Kg New
- `499`: Ekart Surface 20Kg

### Amazon Shipping (ATS)
- `142`: Amazon Prepaid Surface 500g
- `195`: Amazon COD Surface 500gm
- `29`: Amazon Shipping Surface 1kg
- `32`: Amazon Shipping Surface 2kg
- `4`: Amazon Shipping Surface 5kg
- `181`: Amazon Shipping Surface 10kg

### India Post
- `389`: India Post - Speed Post Air
- `217`: India Post - Speed Post Air Prepaid
- `396`: India Post - Business Parcel Surface
- `225`: India Post - Business Parcel Surface Prepaid

### DTDC
- `196`: DTDC Air 500gm
- `6`: DTDC Surface
- `82`: DTDC Surface 2kg
- `18`: DTDC Surface 5kg
- `207`: DTDC Surface 10kg
- `208`: DTDC Surface 20kg

### Ecom Express
- `228`: Ecom Air 500gm
- `14`: Ecom Express Surface
- `19`: Ecom Express Surface 2kg
- `298`: Ecom Express Surface 5kg
- `320`: Ecom Express Surface 10kg
- `60`: Ecom Premium and ROS Surface

---

## 4. Reverse Logistics (`service_type: 2`)

- `61`: Delhivery Reverse Surface
- `138`: Delhivery Reverse Surface 5kg
- `45`: Ecom Express Reverse Surface
- `99`: Ecom Express ROS Reverse Air
- `46`: Shadowfax Reverse Surface

---

## 5. Integration Notes for developers

- **Location in Code**: Handled in `src/services/delivery/shiprocket.ts`.
- **Hyperlocal Filter**: Passing `is_new_hyperlocal = 1` restricts courier serviceability responses to `service_type: 3` couriers.
- **Auto-Ship Assignment**: Passing `is_hyperlocal: 1` in `POST /courier/assign/awb` instructs Shiprocket to pick the nearest active rider from `service_type: 3` partners.

---

## 6. Live Shiprocket Quick Order Payload & Rider Schema

Based on live production responses (`GET /v1/hyperlocal/orders/hyperlocal`):

### Rider Details Object (`rider_details`)
```json
"rider_details": {
    "rider_name": "D VENKATESWARLU",
    "rider_contact": "9666985896",
    "rider_lat": 17.49370313405116,
    "rider_long": 78.40214598923922,
    "distance_between_rider_and_pickup": "2.185"
}
```

### Hyperlocal Activity Lifecycle Sequence (`activities`)
$$\text{ORDER\_CREATED} \rightarrow \text{SEARCHING\_FOR\_RIDER} \rightarrow \text{RIDER\_ASSIGNED} \rightarrow \text{LABEL\_GENERATED} \rightarrow \text{ORDER\_CANCELLED}$$

### Real Shipment Data Structure (`shipments[0]`)
- **Assigned Courier**: `Quick-Rapido` (`courier_id: 959`)
- **AWB Format**: 24-character hexadecimal string (e.g., `6a6e59d3aae1975dc4f3c2d3`)
- **Pickup Location**: Code `work` (`pickup_address_detail.id: 86627402`, *5, Kukatpally Housing Board Rd, Hyderabad 500072*)

