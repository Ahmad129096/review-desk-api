import cors from "cors";
import express from "express";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { env } from "./config/env.js";
import { errorHandler } from "./middleware/error.js";
import { authRoutes } from "./routes/auth.js";
import { businessRoutes } from "./routes/businesses.js";
import { reviewRoutes } from "./routes/reviews.js";
import { taskRoutes } from "./routes/tasks.js";
import { billingRoutes, stripeWebhookRoutes } from "./routes/billing.js";
import { googleRoutes } from "./routes/google.js";

export function createApp() {
  const app = express();

  app.use(helmet());
  app.use(
    cors({
      origin: "*",
      credentials: true,
    }),
  );
  app.use(
    rateLimit({
      windowMs: 60_000,
      limit: 120,
    }),
  );
  app.get("/health", (_req, res) => {
    res.json({
      ok: true,
      service: "reviewdesk-api",
      time: new Date().toISOString(),
    });
  });

  app.use(
    "/api/webhooks/stripe",
    express.raw({ type: "application/json" }),
    stripeWebhookRoutes,
  );
  app.use(express.json({ limit: "1mb" }));

  app.use("/api/auth", authRoutes);
  app.use("/api/businesses", businessRoutes);
  app.use("/api/reviews", reviewRoutes);
  app.use("/api/tasks", taskRoutes);
  app.use("/api/billing", billingRoutes);
  app.use("/api/google", googleRoutes);

  app.use(errorHandler);

  return app;
}
