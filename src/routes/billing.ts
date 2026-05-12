import { Router } from "express";
import Stripe from "stripe";
import { z } from "zod";
import { env } from "../config/env.js";
import { prisma } from "../lib/prisma.js";
import { requireAuth } from "../middleware/auth.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { HttpError } from "../utils/httpError.js";

export const billingRoutes = Router();
export const stripeWebhookRoutes = Router();

const stripe = env.STRIPE_SECRET_KEY ? new Stripe(env.STRIPE_SECRET_KEY) : null;

function mapStripeStatus(status: Stripe.Subscription.Status) {
  if (status === "active") return "ACTIVE";
  if (status === "trialing") return "TRIALING";
  if (status === "past_due") return "PAST_DUE";
  if (status === "incomplete") return "INCOMPLETE";
  return "CANCELED";
}

function planFromPriceId(priceId?: string | null) {
  if (priceId && priceId === env.STRIPE_STARTER_PRICE_ID) return "STARTER";
  if (priceId && priceId === env.STRIPE_PRO_PRICE_ID) return "PRO";
  return undefined;
}

async function upsertSubscription(subscription: Stripe.Subscription, fallbackUserId?: string, fallbackPlan?: string) {
  const userId = subscription.metadata.userId ?? fallbackUserId;
  const priceId = subscription.items.data[0]?.price.id;
  const plan = subscription.metadata.plan ?? fallbackPlan ?? planFromPriceId(priceId);

  if (!userId || !plan || !["STARTER", "PRO"].includes(plan)) {
    return;
  }

  const existing = await prisma.subscription.findFirst({
    where: { stripeSubscriptionId: subscription.id }
  });

  if (existing) {
    await prisma.subscription.update({
      where: { id: existing.id },
      data: {
        stripeCustomerId: typeof subscription.customer === "string" ? subscription.customer : subscription.customer.id,
        plan: plan as "STARTER" | "PRO",
        status: mapStripeStatus(subscription.status),
        currentPeriodStart: new Date(subscription.current_period_start * 1000),
        currentPeriodEnd: new Date(subscription.current_period_end * 1000)
      }
    });
    return;
  }

  await prisma.subscription.create({
    data: {
      userId,
      stripeCustomerId: typeof subscription.customer === "string" ? subscription.customer : subscription.customer.id,
      stripeSubscriptionId: subscription.id,
      plan: plan as "STARTER" | "PRO",
      status: mapStripeStatus(subscription.status),
      currentPeriodStart: new Date(subscription.current_period_start * 1000),
      currentPeriodEnd: new Date(subscription.current_period_end * 1000)
    }
  });
}

stripeWebhookRoutes.post(
  "/",
  asyncHandler(async (req, res) => {
    if (!stripe || !env.STRIPE_WEBHOOK_SECRET) {
      throw new HttpError(501, "Stripe webhooks are not configured");
    }

    const signature = req.headers["stripe-signature"];
    if (!signature) {
      throw new HttpError(400, "Stripe signature is missing");
    }

    let event: Stripe.Event;
    try {
      event = stripe.webhooks.constructEvent(req.body, signature, env.STRIPE_WEBHOOK_SECRET);
    } catch {
      throw new HttpError(400, "Invalid Stripe webhook signature");
    }

    if (event.type === "checkout.session.completed") {
      const session = event.data.object as Stripe.Checkout.Session;
      if (typeof session.subscription === "string") {
        const subscription = await stripe.subscriptions.retrieve(session.subscription);
        await upsertSubscription(subscription, session.metadata?.userId, session.metadata?.plan);
      }
    }

    if (event.type === "customer.subscription.updated" || event.type === "customer.subscription.deleted") {
      await upsertSubscription(event.data.object as Stripe.Subscription);
    }

    res.json({ received: true });
  })
);

billingRoutes.use(requireAuth);

billingRoutes.post(
  "/checkout",
  asyncHandler(async (req, res) => {
    if (!stripe) {
      throw new HttpError(501, "Stripe is not configured");
    }

    const input = z.object({ plan: z.enum(["STARTER", "PRO"]) }).parse(req.body);
    const priceId = input.plan === "STARTER" ? env.STRIPE_STARTER_PRICE_ID : env.STRIPE_PRO_PRICE_ID;

    if (!priceId) {
      throw new HttpError(500, "Stripe price ID is missing");
    }

    const user = await prisma.user.findUnique({ where: { id: req.user!.id } });
    if (!user) {
      throw new HttpError(404, "User not found");
    }

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer_email: user.email,
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${env.WEB_APP_URL}/billing?success=true`,
      cancel_url: `${env.WEB_APP_URL}/billing?canceled=true`,
      subscription_data: {
        metadata: {
          userId: user.id,
          plan: input.plan
        }
      },
      metadata: {
        userId: user.id,
        plan: input.plan
      }
    });

    res.json({ url: session.url });
  })
);
