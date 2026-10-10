# RideFlow Phase 25 — Parcel dispatch, indicative pricing and handover verification

Extends Phase 24. Parcel Delivery remains ON by default and admin-only ON/OFF controls remain unchanged.

## Backend features

- `POST /api/mobile/parcel/quote` customer-only indicative fare: `weightKg`, `distanceKm`. **Distance is caller-supplied, not independently verified; never charge based on this quote.** Demonstration formula: ₹40 + ₹12/km + ₹6/kg above the first kg.
- `GET /api/admin/parcel/drivers/:cityId` eligible online couriers.
- `POST /api/admin/parcel/deliveries/:id/assign` admin/dispatcher with `{driverId,distanceKm}`; only requested parcels; checks courier status, city and vehicle; refuses an existing active parcel. **Dispatchers must verify distance independently.**
- `GET /api/mobile/parcel/courier/deliveries` driver assigned parcel list.
- `POST /api/mobile/parcel/deliveries/:id/code` customer issues a 6-digit pickup or delivery handover code when appropriate. Only a SHA-256 hash is persisted; customer must share the code at the handover point.
- `POST /api/mobile/parcel/courier/deliveries/:id/pickup` assigned courier verifies pickup code, transitions ACCEPTED → PICKED_UP.
- `POST /api/mobile/parcel/courier/deliveries/:id/deliver` assigned courier verifies delivery code, transitions PICKED_UP → DELIVERED.
- Failed verification capped at 5 attempts. The parcel status is available via the existing customer/admin parcel list endpoints.

## Database

```bash
cd apps/api
npm install
npx prisma migrate dev --name parcel_dispatch_handover
npm run start:dev
```

## Limitations

No embedded courier parcel UI yet; endpoints are available for integration. Pricing is indicative and not a payment request. Codes do not yet expire and are not delivered via SMS. Production needs encrypted code distribution, abuse throttling, transactional concurrency locks, road-distance validation, courier offer acceptance, proof-of-delivery evidence, insurance/size rules, refund policy, real-time tracking and audit logging. The backend has not been compiled or database-migrated in this environment.

## Phase 27
See `README_PHASE27.md` for customer-scoped courier tracking, admin delivery-evidence notes, and handover-code lockout hardening.


See README_PHASE28.md for parcel tracking map changes and outstanding work.

## Phase 31 — Separate parcel online payments

Adds `ParcelPayment` as a distinct Prisma ledger and `/api/parcel-payments/:id/{stripe,razorpay}` customer checkout-initiation routes. Signed parcel-specific webhooks at `/api/parcel-payments/{stripe,razorpay}/webhook` confirm captured payments only after provider signature, amount, currency and reference checks. Payment attempts lock the provider and amount; existing cash collection cannot be initiated after an online payment record exists. Stripe uses a stable idempotency key; Razorpay retries may need provider-side reconciliation after network failures.

**Migration:** `cd apps/api && npx prisma migrate dev --name parcel_online_payments`.

**Important:** Parcel checkout is backend-only in this phase; the Flutter parcel screen is not yet wired to these routes. Existing mobile Stripe/Razorpay checkout widgets need parcel-specific API wiring. Refund endpoints and settlement reconciliation for parcel payments are not yet implemented. Webhook URLs must be registered separately with each provider. The parcel fare is still dispatcher-entered indicative pricing, not a validated customer-accepted locked quote. Full application compilation, DB tests and gateway sandbox transactions are pending. Do not accept real parcel payments until those issues are resolved.
