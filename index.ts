/**
 * x402-stripe: API key authentication + Stripe metered billing with prepaid credits.
 *
 * Provides an alternative payment path to x402: users with an API key
 * skip the x402 payment flow and get billed via Stripe metered subscriptions
 * backed by prepaid credit grants.
 *
 * Usage:
 *   import { stripeApiKeyMiddleware } from "x402-stripe";
 *   import { cdpPaymentMiddleware } from "x402-cdp";
 *
 *   // API key users skip x402
 *   app.use(stripeApiKeyMiddleware({ serviceName: "qr-code" }));
 *
 *   // x402 only runs if no API key was provided
 *   app.use(async (c, next) => {
 *     if (c.get("skipX402")) return next();
 *     return cdpPaymentMiddleware((env) => ({ ... }))(c, next);
 *   });
 *
 * Requires CF Worker env bindings:
 *   - API_KEYS: KV namespace containing API key records
 *   - STRIPE_SECRET_KEY: Stripe secret key (secret via `wrangler secret put`)
 *
 * KV schema (key = the API key string):
 *   {
 *     "userId": "user_abc123",
 *     "stripeCustomerId": "cus_xxxxx",
 *     "email": "user@example.com",
 *     "name": "Acme Corp",
 *     "active": true,
 *     "createdAt": "2026-03-14T00:00:00Z"
 *   }
 *
 * Credit balance is cached in KV as "balance:<stripeCustomerId>" with a 60s TTL.
 */

import type { MiddlewareHandler } from "hono";

export interface ApiKeyData {
  userId: string;
  stripeCustomerId: string;
  email?: string;
  name?: string;
  active: boolean;
  createdAt: string;
}

interface StripeMiddlewareOptions {
  /** Service name used as the Stripe meter event name, e.g. "qr-code" */
  serviceName: string;
}

const API_KEY_PREFIX = "sk_camel_";
const BALANCE_CACHE_TTL = 60; // seconds

async function getCreditBalance(
  stripeKey: string,
  customerId: string,
  kv: KVNamespace
): Promise<number> {
  // Check KV cache first
  const cacheKey = `balance:${customerId}`;
  const cached = await kv.get(cacheKey);
  if (cached !== null) {
    return parseInt(cached, 10);
  }

  // Fetch from Stripe
  const params = new URLSearchParams({
    customer: customerId,
    "filter[type]": "applicability_scope",
    "filter[applicability_scope][price_type]": "metered",
  });

  const res = await fetch(
    `https://api.stripe.com/v1/billing/credit_balance_summary?${params}`,
    {
      headers: { Authorization: `Basic ${btoa(stripeKey + ":")}` },
    }
  );

  let balance = 0;
  if (res.ok) {
    const data = (await res.json()) as any;
    balance = data.balances?.[0]?.available_balance?.monetary?.value ?? 0;
  }

  // Cache for 60s
  await kv.put(cacheKey, String(balance), { expirationTtl: BALANCE_CACHE_TTL });

  return balance;
}

export function stripeApiKeyMiddleware(
  options: StripeMiddlewareOptions
): MiddlewareHandler {
  return async (c, next) => {
    // Check for API key in Authorization header or X-API-Key
    const authHeader = c.req.header("Authorization");
    const xApiKey = c.req.header("X-API-Key");

    let apiKey: string | undefined;
    if (authHeader?.startsWith(`Bearer ${API_KEY_PREFIX}`)) {
      apiKey = authHeader.slice(7);
    } else if (xApiKey?.startsWith(API_KEY_PREFIX)) {
      apiKey = xApiKey;
    }

    if (!apiKey) {
      // No API key — fall through to x402
      return next();
    }

    // Look up key in KV
    const env = c.env as Record<string, any>;
    const kv = env.API_KEYS as KVNamespace | undefined;
    if (!kv) {
      // KV not configured — fall through to x402
      return next();
    }

    const raw = await kv.get(apiKey, { cacheTtl: 60 });
    if (!raw) {
      return c.json({ error: "Invalid API key" }, 401);
    }

    const keyData: ApiKeyData = JSON.parse(raw);
    if (!keyData.active) {
      return c.json({ error: "API key is deactivated" }, 403);
    }

    // Check credit balance
    const stripeKey = env.STRIPE_SECRET_KEY as string | undefined;
    if (stripeKey) {
      const balance = await getCreditBalance(stripeKey, keyData.stripeCustomerId, kv);
      if (balance <= 0) {
        return c.json(
          {
            error: "Insufficient credits",
            balance: 0,
            message: "Purchase more credits to continue using the API",
          },
          402
        );
      }

    }

    // Mark request as API-key-authenticated so x402 middleware is skipped
    c.set("skipX402", true);
    c.set("apiKeyUser", keyData);

    // Run the handler first
    await next();

    // Only meter usage if the handler succeeded (match x402 settle behavior)
    if (stripeKey && c.res && c.res.status < 400) {
      const meterPromise = fetch("https://api.stripe.com/v2/billing/meter_events", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${stripeKey}`,
          "Content-Type": "application/json",
          "Stripe-Version": "2025-11-17.clover",
        },
        body: JSON.stringify({
          event_name: `camelai_${options.serviceName.replace(/-/g, "_")}`,
          payload: {
            stripe_customer_id: keyData.stripeCustomerId,
            value: "1",
          },
        }),
      }).catch((e) => {
        console.error("Stripe meter event failed:", e);
      });

      if (c.executionCtx?.waitUntil) {
        c.executionCtx.waitUntil(meterPromise);
      }
    }

    return;
  };
}

/**
 * Generate a new API key string.
 * Use this in admin scripts to create keys.
 */
export function generateApiKey(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${API_KEY_PREFIX}${hex}`;
}
