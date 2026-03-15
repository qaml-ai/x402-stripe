/**
 * x402-stripe: API key authentication + Stripe metered billing middleware.
 *
 * Provides an alternative payment path to x402: users with an API key
 * skip the x402 payment flow and get billed via Stripe metered subscriptions.
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

    // Report usage to Stripe Meter Events API
    const stripeKey = env.STRIPE_SECRET_KEY as string | undefined;
    if (stripeKey) {
      const meterEvent = {
        event_name: `camelai_${options.serviceName.replace(/-/g, "_")}`,
        payload: {
          stripe_customer_id: keyData.stripeCustomerId,
          value: "1",
        },
      };

      // Fire and don't block the response
      const meterPromise = fetch("https://api.stripe.com/v2/billing/meter_events", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${stripeKey}`,
          "Content-Type": "application/json",
          "Stripe-Version": "2025-11-17.clover",
        },
        body: JSON.stringify(meterEvent),
      }).catch((e) => {
        console.error("Stripe meter event failed:", e);
      });

      // Use waitUntil so the meter call completes even after response is sent
      if (c.executionCtx?.waitUntil) {
        c.executionCtx.waitUntil(meterPromise);
      }
    }

    // Mark request as API-key-authenticated so x402 middleware is skipped
    c.set("skipX402", true);
    c.set("apiKeyUser", keyData);

    return next();
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
