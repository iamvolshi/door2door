# Third-Party Service Integrations & Operating Cost Model

This document provides an audit of all external service integrations, rate cards, and projected operational costs for running the pilot MVP in Cox's Bazar.

---

## 1. Third-Party Services Breakdown

| Service Domain | Primary Provider | Fallback Provider | Pricing Model | Unit Cost (BDT / USD) |
| :--- | :--- | :--- | :--- | :--- |
| **SMS OTP / Alerts** | Greenweb BD | BulkSMSBD | Per SMS message | BDT 0.25 - 0.35 / SMS (~$0.003) |
| **MFS Payment - bKash** | bKash Tokenized API | Manual bKash Personal/B2B | % per successful tx | 1.2% - 1.5% per tx |
| **MFS Payment - Nagad** | Nagad PGW Direct | Nagad Merchant Pay | % per successful tx | 1.0% - 1.2% per tx |
| **Maps & Routing** | OpenStreetMap + Self-hosted OSRM | Google Maps Platform | Server Hosting / Quotas | $0.00 (OSRM free) vs $0.005/req Google |
| **Cloud Hosting (VPS)** | DigitalOcean / Hetzner VPS | Local CXB Server / AWS | Monthly flat VM rate | $12.00 - $24.00 / mo (~BDT 1,400 - 2,800) |
| **Object Storage (CDN)** | Cloudflare R2 / AWS S3 | Local Disk Mount | GB / Egress | $0.015 / GB (R2 has zero egress fee) |
| **Domain & SSL** | Namecheap / Let's Encrypt | Cloudflare Universal SSL | Annual / Free | $12.00 / yr Domain; SSL is Free |

---

## 2. Low-Cost MVP Operational Cost Projections (Cox's Bazar Pilot)

### Phase 1 Pilot Volume Assumptions:
- **Active Daily Orders**: 150 - 300 orders/day (4,500 - 9,000 orders/month)
- **Active Drivers**: 25 TomTom (electric tricycle) & bicycle riders
- **Partner Merchants**: 35 restaurants, pharmacies & souvenir shops in Kolatoli, Laboni, and Sugandha

### Monthly Budget Estimate (BDT & USD)

| Item | Monthly Usage | Cost in BDT | Cost in USD |
| :--- | :--- | :--- | :--- |
| **SMS Gateway (OTP & Order Status)** | ~18,000 SMS messages | BDT 5,400 | $46.00 |
| **Cloud Infrastructure (4 vCPU, 8GB RAM VPS)** | 1 VPS instance | BDT 2,800 | $24.00 |
| **Database Backups & Media Storage (R2)** | 25 GB storage + assets | BDT 350 | $3.00 |
| **Payment Gateway Commission (bKash/Nagad)** | ~40% online payments on BDT 2.5M GMV | Variable (paid from GMV cut) | Included in GMV |
| **Domain, DNS & Monitoring (UptimeRobot, Cloudflare)** | Pro DNS / CDN | BDT 0 (Free Tier) | $0.00 |
| **Hub Office Operations (Laboni Beach Point)** | Electricity, Wi-Fi & Support Desk | BDT 8,000 | $68.00 |
| **Total Estimated Fixed Tech Run Cost** | **Monthly** | **BDT ~8,550** | **~$73.00 / mo** |

---

## 3. Cost Optimization Strategies for Bangladesh Hyperlocal Context
1. **Zero Map API Fees**: By utilizing OpenStreetMap tile rendering with local OSRM graph routing tailored to Cox's Bazar municipal road paths, the platform saves $300-$500/month in Google Maps API billing.
2. **SMS Optimization**: Deliver order lifecycle tracking updates via WebSockets and push notifications first; only send SMS for high-priority events (Phone OTP verification, driver assigned alert).
3. **SQLite / PostgreSQL Hybrid**: For single-node pilot rollouts, SQLite WAL mode reduces server memory footprint, allowing the entire stack to run comfortably on a $12/month cloud server.
