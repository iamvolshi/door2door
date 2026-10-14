# Cox's Bazar Pilot Launch Strategy & Operational Runbook

## Executive Summary
Cox's Bazar is Bangladesh's primary tourist destination with high seasonal demand, vibrant culinary culture, and unique logistical conditions (dense hotel corridors, TomTom electric tricycles, sea beach accessibility). This document details the 6-phase rollout strategy for launching and operating the platform.

---

## 1. Pilot Zones Breakdown

```
+----------------------------------------------------------------------+
| Zone 1: Kolatoli Beach Point & Hotel Strip                          |
| Focus: Tourist hotels, fast seafood, evening snacks, midnight orders|
+----------------------------------------------------------------------+
| Zone 2: Laboni Beach & Burmese Market                                |
| Focus: Souvenirs, dry fish (Shukti), local street food, pharmacies   |
+----------------------------------------------------------------------+
| Zone 3: Sugandha Beach Point & Main Market Road                      |
| Focus: High-density restaurants, fruit markets, daily groceries     |
+----------------------------------------------------------------------+
| Zone 4: Marine Drive & Inani Corridor (Extended Pilot)               |
| Focus: Luxury resorts, scheduled delivery batches                   |
+----------------------------------------------------------------------+
```

---

## 2. 6-Phase Operational Rollout Plan

### Phase 1: Pre-Launch Merchant & Driver Onboarding (Weeks 1 - 2)
- Onboard 30 flagship restaurants (e.g., Poushee, Jhawbon, Koyla, Handi) and 10 pharmacies.
- Recruit and train 20 delivery riders (12 TomTom drivers + 8 bicycle couriers).
- Provide thermal insulated delivery bags with branded CXB Express branding.
- Deploy pilot menu QR codes to partner front desks.

### Phase 2: Closed Alpha Testing (Week 3)
- Execute end-to-end simulated ordering across all 4 pilot zones.
- Stress test bKash and Nagad payment callbacks with simulated network delays.
- Validate driver dispatch allocation timeouts (45 seconds response window).

### Phase 3: Soft Launch in Kolatoli & Sugandha (Weeks 4 - 5)
- Open public ordering between 10:00 AM to 11:00 PM.
- Offer promotional code `COXLAUNCH` (BDT 50 off on orders over BDT 300).
- Monitor driver delivery times, aiming for sub-32 minute average delivery.

### Phase 4: Full Multi-Service Activation (Weeks 6 - 8)
- Enable 24/7 Pharmacy & Emergency essentials delivery.
- Launch Dry Fish (Shukti) & Souvenir shipping module for tourists returning to Dhaka/Chittagong.
- Introduce customer live chat support in Bengali and English.

### Phase 5: Hotel Concierge & QR Code Integration (Weeks 9 - 12)
- Partner with 15 major hotels in Kolatoli and Sea Beach Road.
- Place customized in-room dining menus powered by CXB Express.
- Commission sharing structure for hotel reception desks.

### Phase 6: Regional Scale & Expansion (Month 4+)
- Expand coverage along Marine Drive to Inani Beach.
- Introduce inter-city parcel dispatch to Chittagong via local AC bus counters.

---

## 3. Incident Management & Support Runbook

| Issue Severity | Scenario | Resolution Protocol |
| :--- | :--- | :--- |
| **P1 - Critical** | Payment gateway callback down | Fall back to manual SMS transaction ID verification; auto-enable COD |
| **P2 - High** | Driver shortage in Sugandha during rain | Trigger +BDT 20 surge incentive; extend delivery window to 45 mins |
| **P3 - Medium** | Merchant out of ordered stock | Support rep contacts customer within 3 mins; suggests alternative item |
| **P4 - Low** | Minor app UI localization glitch | Fix scheduled for next nightly sprint deploy |
