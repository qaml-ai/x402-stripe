# Auto-Refill Credits (Future)

## Approach: KV Threshold Check in Middleware

No webhooks. The existing middleware already fetches the credit balance on each request (cached 60s in KV). When the balance drops below a threshold, trigger a refill inline via `waitUntil`.

## KV Schema Change

Add refill config to the API key record:

```json
{
  "userId": "user_abc123",
  "stripeCustomerId": "cus_xxxxx",
  "active": true,
  "autoRefill": {
    "enabled": true,
    "thresholdCents": 100,
    "refillAmountCents": 500,
    "paymentMethodId": "pm_xxxxx"
  }
}
```

## Flow

1. Request comes in with API key
2. Middleware fetches credit balance (from cache or Stripe)
3. If `balance <= 0` → block request with 402
4. If `balance > 0 && balance <= thresholdCents && autoRefill.enabled`:
   - Set a KV lock (`refill:<customerId>` with 120s TTL) to prevent duplicate refills
   - In `waitUntil`:
     a. Charge their payment method via `POST /v1/payment_intents` (amount = `refillAmountCents`, confirm = true)
     b. On success, create a new credit grant via `POST /v1/billing/credit_grants`
     c. Invalidate the balance cache in KV
5. Current request proceeds normally (they still have credits)

## Code Sketch

```typescript
// Inside stripeApiKeyMiddleware, after balance check passes:

if (
  keyData.autoRefill?.enabled &&
  balance > 0 &&
  balance <= keyData.autoRefill.thresholdCents
) {
  const lockKey = `refill:${keyData.stripeCustomerId}`;
  const locked = await kv.get(lockKey);

  if (!locked) {
    // Claim the lock
    await kv.put(lockKey, "1", { expirationTtl: 120 });

    const refillPromise = (async () => {
      try {
        // 1. Charge payment method
        const pi = await fetch("https://api.stripe.com/v1/payment_intents", {
          method: "POST",
          headers: { Authorization: `Basic ${btoa(stripeKey + ":")}` },
          body: new URLSearchParams({
            amount: String(keyData.autoRefill.refillAmountCents),
            currency: "usd",
            customer: keyData.stripeCustomerId,
            payment_method: keyData.autoRefill.paymentMethodId,
            confirm: "true",
            off_session: "true",
          }),
        });
        const piData = await pi.json();
        if (piData.status !== "succeeded") return;

        // 2. Create credit grant
        await fetch("https://api.stripe.com/v1/billing/credit_grants", {
          method: "POST",
          headers: { Authorization: `Basic ${btoa(stripeKey + ":")}` },
          body: new URLSearchParams({
            name: "Auto-refill",
            customer: keyData.stripeCustomerId,
            "amount[type]": "monetary",
            "amount[monetary][value]": String(keyData.autoRefill.refillAmountCents),
            "amount[monetary][currency]": "usd",
            category: "paid",
            "applicability_config[scope][price_type]": "metered",
          }),
        });

        // 3. Invalidate balance cache
        await kv.delete(`balance:${keyData.stripeCustomerId}`);
      } catch (e) {
        console.error("Auto-refill failed:", e);
      }
    })();

    c.executionCtx.waitUntil(refillPromise);
  }
}
```

## Edge Cases

- **Duplicate refills**: The KV lock (`refill:<customerId>`, 120s TTL) prevents concurrent requests from triggering multiple refills. KV is eventually consistent so there's a small window for duplicates, but the worst case is an extra $5 credit which is harmless.
- **Payment failure**: If the charge fails (card declined, etc.), the refill silently fails. The customer keeps using remaining credits until they hit 0 and get blocked. We could store the failure in KV and surface it in the 402 response.
- **Cache staleness**: After a refill, the balance cache is invalidated. Next request will fetch fresh balance from Stripe.
- **Off-session payments**: Requires the customer to have a saved payment method with `off_session` consent. This is set up during initial checkout.

## Prerequisites

- Customer must have a saved payment method (`pm_xxxxx`) stored in their KV record
- Payment method must be set up for off-session use (SCA/3DS completed upfront)
- Could use Stripe Checkout to handle the initial payment method setup + first credit purchase
