import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { requireAuth } from "../middleware/auth.js";
import { analyzeAndUpdateReview } from "../services/reviewAutomation.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { HttpError } from "../utils/httpError.js";
import { planLimits } from "../utils/plans.js";

export const reviewRoutes = Router();

reviewRoutes.use(requireAuth);

const createReviewSchema = z.object({
  businessId: z.string().min(1),
  reviewerName: z.string().optional(),
  rating: z.number().int().min(1).max(5),
  content: z.string().min(5),
  reviewDate: z.string().datetime().optional()
});

const updateReviewSchema = z.object({
  reviewerName: z.string().optional(),
  rating: z.number().int().min(1).max(5).optional(),
  content: z.string().min(5).optional(),
  reviewDate: z.string().datetime().nullable().optional(),
  status: z.enum(["NEW", "REPLIED", "FOLLOW_UP", "RESOLVED"]).optional()
});

const importReviewsSchema = z.object({
  businessId: z.string().min(1),
  csv: z.string().min(1)
});

async function assertBusinessAccess(businessId: string, userId: string) {
  const business = await prisma.business.findFirst({
    where: { id: businessId, ownerId: userId }
  });

  if (!business) {
    throw new HttpError(404, "Business not found");
  }

  return business;
}

async function assertUsageAvailable(userId: string, quantity = 1) {
  const subscription = await prisma.subscription.findFirst({
    where: { userId, status: { in: ["ACTIVE", "TRIALING"] } },
    orderBy: { createdAt: "desc" }
  });
  const plan = subscription?.plan ?? "FREE";
  const startOfMonth = new Date();
  startOfMonth.setUTCDate(1);
  startOfMonth.setUTCHours(0, 0, 0, 0);

  const usage = await prisma.usageEvent.aggregate({
    where: {
      userId,
      eventType: "AI_REPLY_GENERATED",
      createdAt: { gte: startOfMonth }
    },
    _sum: { quantity: true }
  });

  if ((usage._sum.quantity ?? 0) + quantity > planLimits[plan]) {
    throw new HttpError(402, "Monthly AI reply limit reached. Upgrade your plan to continue.");
  }
}

function parseCsvLine(line: string) {
  const values: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    const next = line[index + 1];

    if (char === '"' && inQuotes && next === '"') {
      current += '"';
      index += 1;
    } else if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === "," && !inQuotes) {
      values.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }

  values.push(current.trim());
  return values;
}

function parseReviewCsv(csv: string) {
  const lines = csv
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length < 2) {
    throw new HttpError(400, "CSV must include a header row and at least one review row");
  }

  const headers = parseCsvLine(lines[0]).map((header) => header.toLowerCase().replace(/[\s_-]/g, ""));
  const rows = lines.slice(1).map((line) => {
    const values = parseCsvLine(line);
    const get = (...names: string[]) => {
      const index = headers.findIndex((header) => names.includes(header));
      return index >= 0 ? values[index] : undefined;
    };

    const rating = Number(get("rating", "stars"));
    const content = get("content", "review", "reviewtext", "text");

    return {
      reviewerName: get("reviewername", "reviewer", "customer", "name") || undefined,
      rating,
      content,
      reviewDate: get("reviewdate", "date") || undefined
    };
  });

  if (rows.length > 50) {
    throw new HttpError(400, "CSV import is limited to 50 reviews at a time");
  }

  return rows.map((row, index) => {
    if (!Number.isInteger(row.rating) || row.rating < 1 || row.rating > 5 || !row.content || row.content.length < 5) {
      throw new HttpError(400, `CSV row ${index + 2} must include rating 1-5 and review content`);
    }

    return row;
  });
}

reviewRoutes.get(
  "/",
  asyncHandler(async (req, res) => {
    const businessId = z.string().optional().parse(req.query.businessId);
    const businesses = await prisma.business.findMany({
      where: { ownerId: req.user!.id },
      select: { id: true }
    });
    const allowedBusinessIds = businesses.map((business) => business.id);

    if (businessId && !allowedBusinessIds.includes(businessId)) {
      throw new HttpError(404, "Business not found");
    }

    const reviews = await prisma.review.findMany({
      where: { businessId: businessId ?? { in: allowedBusinessIds } },
      include: { business: { select: { name: true } } },
      orderBy: { createdAt: "desc" }
    });

    res.json({ reviews });
  })
);

reviewRoutes.get(
  "/:id",
  asyncHandler(async (req, res) => {
    const id = z.string().parse(req.params.id);
    const review = await prisma.review.findFirst({
      where: {
        id,
        business: { ownerId: req.user!.id }
      },
      include: { business: { select: { name: true } } }
    });

    if (!review) {
      throw new HttpError(404, "Review not found");
    }

    res.json({ review });
  })
);

reviewRoutes.post(
  "/",
  asyncHandler(async (req, res) => {
    const input = createReviewSchema.parse(req.body);
    const business = await assertBusinessAccess(input.businessId, req.user!.id);
    await assertUsageAvailable(req.user!.id);

    const review = await prisma.review.create({
      data: {
        businessId: business.id,
        reviewerName: input.reviewerName,
        rating: input.rating,
        content: input.content,
        reviewDate: input.reviewDate ? new Date(input.reviewDate) : null
      }
    });

    const analyzedReview = await analyzeAndUpdateReview(review, business, req.user!.id);

    res.status(201).json({ review: analyzedReview });
  })
);

reviewRoutes.post(
  "/import",
  asyncHandler(async (req, res) => {
    const input = importReviewsSchema.parse(req.body);
    const business = await assertBusinessAccess(input.businessId, req.user!.id);
    const rows = parseReviewCsv(input.csv);
    await assertUsageAvailable(req.user!.id, rows.length);

    const reviews = [];
    for (const row of rows) {
      const review = await prisma.review.create({
        data: {
          businessId: business.id,
          source: "CSV",
          reviewerName: row.reviewerName,
          rating: row.rating,
          content: row.content!,
          reviewDate: row.reviewDate ? new Date(row.reviewDate) : null
        }
      });

      reviews.push(await analyzeAndUpdateReview(review, business, req.user!.id));
    }

    res.status(201).json({ reviews });
  })
);

reviewRoutes.post(
  "/:id/generate-reply",
  asyncHandler(async (req, res) => {
    const id = z.string().parse(req.params.id);
    const review = await prisma.review.findFirst({
      where: {
        id,
        business: { ownerId: req.user!.id }
      }
    });

    if (!review) {
      throw new HttpError(404, "Review not found");
    }

    await assertUsageAvailable(req.user!.id);
    const business = await assertBusinessAccess(review.businessId, req.user!.id);
    const updated = await analyzeAndUpdateReview(review, business, req.user!.id);

    res.json({ review: updated });
  })
);

reviewRoutes.patch(
  "/:id",
  asyncHandler(async (req, res) => {
    const input = updateReviewSchema.parse(req.body);
    const id = z.string().parse(req.params.id);
    const review = await prisma.review.findFirst({
      where: {
        id,
        business: { ownerId: req.user!.id }
      }
    });

    if (!review) {
      throw new HttpError(404, "Review not found");
    }

    const updated = await prisma.review.update({
      where: { id: review.id },
      data: {
        reviewerName: input.reviewerName,
        rating: input.rating,
        content: input.content,
        reviewDate: input.reviewDate === undefined ? undefined : input.reviewDate ? new Date(input.reviewDate) : null,
        status: input.status
      }
    });

    res.json({ review: updated });
  })
);

reviewRoutes.patch(
  "/:id/status",
  asyncHandler(async (req, res) => {
    const input = z.object({ status: z.enum(["NEW", "REPLIED", "FOLLOW_UP", "RESOLVED"]) }).parse(req.body);
    const id = z.string().parse(req.params.id);
    const review = await prisma.review.findFirst({
      where: {
        id,
        business: { ownerId: req.user!.id }
      }
    });

    if (!review) {
      throw new HttpError(404, "Review not found");
    }

    const updated = await prisma.review.update({
      where: { id: review.id },
      data: { status: input.status }
    });

    res.json({ review: updated });
  })
);

reviewRoutes.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    const id = z.string().parse(req.params.id);
    const review = await prisma.review.findFirst({
      where: {
        id,
        business: { ownerId: req.user!.id }
      }
    });

    if (!review) {
      throw new HttpError(404, "Review not found");
    }

    await prisma.review.delete({ where: { id: review.id } });
    res.status(204).send();
  })
);
