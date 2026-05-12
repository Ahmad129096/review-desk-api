import { randomUUID } from "crypto";
import { Router } from "express";
import jwt from "jsonwebtoken";
import { z } from "zod";
import { env } from "../config/env.js";
import { prisma } from "../lib/prisma.js";
import { requireAuth } from "../middleware/auth.js";
import {
  buildGoogleAuthUrl,
  exchangeGoogleCode,
  getUsableAccessToken,
  GoogleConnectionRecord,
  googleStarRatingToNumber,
  listGoogleAccounts,
  listGoogleLocations,
  listGoogleReviews,
  publishGoogleReviewReply,
  tokenExpiresAt,
} from "../services/googleBusinessProfile.js";
import { analyzeAndUpdateReview } from "../services/reviewAutomation.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { HttpError } from "../utils/httpError.js";

export const googleRoutes = Router();

type GoogleState = {
  businessId: string;
  type: "google_oauth";
};

type LinkedReview = {
  id: string;
  businessId: string;
  externalReviewName: string | null;
  aiReply: string | null;
  rating: number;
  sentiment: "POSITIVE" | "NEUTRAL" | "NEGATIVE" | null;
  replyPublishedAt: Date | null;
};

googleRoutes.get(
  "/callback",
  asyncHandler(async (req, res) => {
    console.log("Google OAuth callback received");
    const input = z
      .object({ code: z.string(), state: z.string() })
      .parse(req.query);
    console.log("Query validation passed");

    const state = jwt.verify(input.state, env.JWT_SECRET) as GoogleState & {
      sub: string;
    };
    console.log("JWT verified:", {
      businessId: state.businessId,
      userId: state.sub,
    });

    if (state.type !== "google_oauth") {
      throw new HttpError(400, "Invalid Google OAuth state");
    }

    const business = await prisma.business.findFirst({
      where: { id: state.businessId, ownerId: state.sub },
    });
    console.log("Business lookup result:", business?.id);

    if (!business) {
      throw new HttpError(404, "Business not found");
    }

    console.log("Exchanging Google code for token");
    console.log("Using redirect URI:", env.GOOGLE_REDIRECT_URI);
    console.log("Using client ID:", env.GOOGLE_CLIENT_ID?.substring(0, 20) + "...");
    const token = await exchangeGoogleCode(input.code);
    console.log("Token received:", {
      access_token: token.access_token?.substring(0, 20) + "...",
      refresh_token: !!token.refresh_token,
    });

    await upsertGoogleConnection({
      userId: state.sub,
      businessId: business.id,
      accessToken: token.access_token,
      refreshToken: token.refresh_token,
      tokenExpiresAt: tokenExpiresAt(token.expires_in),
    });
    console.log("Google connection stored");

    console.log("Redirecting to:", `${env.WEB_APP_URL}/?google=connected`);
    res.redirect(`${env.WEB_APP_URL}/?google=connected`);
    return;
  }),
);

googleRoutes.use(requireAuth);

googleRoutes.get(
  "/auth-url",
  asyncHandler(async (req, res) => {
    const businessId = z.string().parse(req.query.businessId);
    await assertBusinessAccess(businessId, req.user!.id);

    const state = jwt.sign(
      { businessId, type: "google_oauth" },
      env.JWT_SECRET,
      {
        subject: req.user!.id,
        expiresIn: "10m",
      },
    );

    res.json({ url: buildGoogleAuthUrl(state) });
  }),
);

googleRoutes.get(
  "/locations",
  asyncHandler(async (req, res) => {
    const businessId = z.string().parse(req.query.businessId);
    const connection = await getConnectionForBusiness(businessId, req.user!.id);
    const access = await getFreshAccess(connection);
    const accounts = await listGoogleAccounts(access.accessToken);
    const locations = [];

    for (const account of accounts) {
      const accountLocations = await listGoogleLocations(
        access.accessToken,
        account.name,
      );
      locations.push(
        ...accountLocations.map((location) => ({
          accountName: account.name,
          accountLabel: account.accountName ?? account.name,
          locationName: location.name,
          title: location.title ?? location.name,
          placeId: location.metadata?.placeId,
        })),
      );
    }

    res.json({ locations });
  }),
);

googleRoutes.post(
  "/location",
  asyncHandler(async (req, res) => {
    const input = z
      .object({
        businessId: z.string(),
        accountName: z.string(),
        locationName: z.string(),
      })
      .parse(req.body);

    await assertBusinessAccess(input.businessId, req.user!.id);
    await prisma.$executeRaw`
      UPDATE "google_connections"
      SET "googleAccountName" = ${input.accountName},
          "googleLocationName" = ${input.locationName},
          "updatedAt" = ${new Date()}
      WHERE "businessId" = ${input.businessId} AND "userId" = ${req.user!.id}
    `;

    res.json({ connected: true });
  }),
);

googleRoutes.post(
  "/sync",
  asyncHandler(async (req, res) => {
    const input = z
      .object({
        businessId: z.string(),
        autoReply: z.boolean().default(false),
        autoReplyMinRating: z.number().int().min(4).max(5).default(5),
      })
      .parse(req.body);

    const business = await assertBusinessAccess(input.businessId, req.user!.id);
    const connection = await getConnectionForBusiness(
      input.businessId,
      req.user!.id,
    );

    if (!connection.googleLocationName) {
      throw new HttpError(
        400,
        "Select a Google Business location before syncing reviews",
      );
    }

    const access = await getFreshAccess(connection);
    const googleReviews = await listGoogleReviews(
      access.accessToken,
      connection.googleLocationName,
    );
    const synced = [];
    let publishedReplies = 0;

    for (const googleReview of googleReviews.reviews) {
      const rating = googleStarRatingToNumber(googleReview.starRating);
      const content =
        googleReview.comment?.trim() ||
        `Google ${rating}-star review with no written comment.`;
      const reviewId = await upsertGoogleReview({
        businessId: business.id,
        externalReviewId: googleReview.reviewId,
        externalReviewName: googleReview.name,
        reviewerName: googleReview.reviewer?.isAnonymous
          ? null
          : (googleReview.reviewer?.displayName ?? null),
        rating,
        content,
        reviewDate: googleReview.createTime
          ? new Date(googleReview.createTime)
          : null,
      });

      const review = await prisma.review.findUnique({
        where: { id: reviewId },
      });
      if (!review) continue;

      const analyzedReview = review.aiReply
        ? review
        : await analyzeAndUpdateReview(review, business, req.user!.id);
      synced.push(analyzedReview);

      if (
        input.autoReply &&
        analyzedReview.aiReply &&
        analyzedReview.sentiment === "POSITIVE" &&
        analyzedReview.rating >= input.autoReplyMinRating &&
        !googleReview.reviewReply?.comment
      ) {
        await publishGoogleReviewReply(
          access.accessToken,
          googleReview.name,
          analyzedReview.aiReply,
        );
        await markReplyPublished(analyzedReview.id);
        publishedReplies += 1;
      }
    }

    res.json({
      reviews: synced,
      importedCount: synced.length,
      publishedReplies,
      averageRating: googleReviews.averageRating,
      totalReviewCount: googleReviews.totalReviewCount,
    });
  }),
);

googleRoutes.post(
  "/reviews/:id/publish-reply",
  asyncHandler(async (req, res) => {
    const id = z.string().parse(req.params.id);
    const review = await getLinkedReview(id, req.user!.id);

    if (!review.externalReviewName) {
      throw new HttpError(400, "This review is not linked to Google");
    }

    if (!review.aiReply) {
      throw new HttpError(400, "Generate a reply before publishing to Google");
    }

    const connection = await getConnectionForBusiness(
      review.businessId,
      req.user!.id,
    );
    const access = await getFreshAccess(connection);
    const googleReply = await publishGoogleReviewReply(
      access.accessToken,
      review.externalReviewName,
      review.aiReply,
    );
    await markReplyPublished(review.id);

    const updated = await prisma.review.update({
      where: { id: review.id },
      data: { status: "REPLIED" },
    });

    res.json({ review: updated, googleReply });
  }),
);

async function assertBusinessAccess(businessId: string, userId: string) {
  const business = await prisma.business.findFirst({
    where: { id: businessId, ownerId: userId },
  });

  if (!business) {
    throw new HttpError(404, "Business not found");
  }

  return business;
}

async function upsertGoogleConnection(input: {
  userId: string;
  businessId: string;
  accessToken: string;
  refreshToken?: string;
  tokenExpiresAt: Date | null;
}) {
  await prisma.$executeRaw`
    INSERT INTO "google_connections"
      ("id", "userId", "businessId", "accessToken", "refreshToken", "tokenExpiresAt", "createdAt", "updatedAt")
    VALUES
      (${randomUUID()}, ${input.userId}, ${input.businessId}, ${input.accessToken}, ${input.refreshToken ?? null}, ${input.tokenExpiresAt}, ${new Date()}, ${new Date()})
    ON CONFLICT ("businessId") DO UPDATE
    SET "accessToken" = EXCLUDED."accessToken",
        "refreshToken" = COALESCE(EXCLUDED."refreshToken", "google_connections"."refreshToken"),
        "tokenExpiresAt" = EXCLUDED."tokenExpiresAt",
        "updatedAt" = EXCLUDED."updatedAt"
  `;
}

async function getConnectionForBusiness(businessId: string, userId: string) {
  await assertBusinessAccess(businessId, userId);
  const rows = await prisma.$queryRaw<GoogleConnectionRecord[]>`
    SELECT *
    FROM "google_connections"
    WHERE "businessId" = ${businessId} AND "userId" = ${userId}
    LIMIT 1
  `;

  if (!rows[0]) {
    throw new HttpError(404, "Google Business Profile is not connected");
  }

  return rows[0];
}

async function getFreshAccess(connection: GoogleConnectionRecord) {
  const access = await getUsableAccessToken(connection);

  if (access.refresh) {
    await prisma.$executeRaw`
      UPDATE "google_connections"
      SET "accessToken" = ${access.refresh.access_token},
          "tokenExpiresAt" = ${tokenExpiresAt(access.refresh.expires_in)},
          "updatedAt" = ${new Date()}
      WHERE "id" = ${connection.id}
    `;
  }

  return access;
}

async function upsertGoogleReview(input: {
  businessId: string;
  externalReviewId: string;
  externalReviewName: string;
  reviewerName: string | null;
  rating: number;
  content: string;
  reviewDate: Date | null;
}) {
  const id = randomUUID();

  const rows = await prisma.$queryRaw<{ id: string }[]>`
    INSERT INTO "reviews"
      ("id", "businessId", "source", "reviewerName", "rating", "content", "reviewDate", "externalReviewId", "externalReviewName", "createdAt", "updatedAt")
    VALUES
      (${id}, ${input.businessId}, 'GOOGLE'::"ReviewSource", ${input.reviewerName}, ${input.rating}, ${input.content}, ${input.reviewDate}, ${input.externalReviewId}, ${input.externalReviewName}, ${new Date()}, ${new Date()})
    ON CONFLICT ("businessId", "externalReviewName") DO UPDATE
    SET "reviewerName" = EXCLUDED."reviewerName",
        "rating" = EXCLUDED."rating",
        "content" = EXCLUDED."content",
        "reviewDate" = EXCLUDED."reviewDate",
        "updatedAt" = EXCLUDED."updatedAt"
    RETURNING "id"
  `;

  return rows[0].id;
}

async function getLinkedReview(id: string, userId: string) {
  const rows = await prisma.$queryRaw<LinkedReview[]>`
    SELECT r."id", r."businessId", r."externalReviewName", r."aiReply", r."rating", r."sentiment", r."replyPublishedAt"
    FROM "reviews" r
    INNER JOIN "businesses" b ON b."id" = r."businessId"
    WHERE r."id" = ${id} AND b."ownerId" = ${userId}
    LIMIT 1
  `;

  if (!rows[0]) {
    throw new HttpError(404, "Review not found");
  }

  return rows[0];
}

async function markReplyPublished(reviewId: string) {
  await prisma.$executeRaw`
    UPDATE "reviews"
    SET "replyPublishedAt" = ${new Date()},
        "status" = 'REPLIED'::"ReviewStatus",
        "updatedAt" = ${new Date()}
    WHERE "id" = ${reviewId}
  `;
}
