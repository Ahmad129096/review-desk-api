import type { Business, Review } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { generateReviewReply } from "./openai.js";

export async function analyzeAndUpdateReview(review: Review, business: Business, userId: string) {
  const ai = await generateReviewReply({
    businessName: business.name,
    industry: business.industry,
    tone: business.defaultTone,
    rating: review.rating,
    reviewText: review.content
  });

  const shouldFollowUp = ai.needsFollowUp || ai.sentiment === "NEGATIVE" || ai.urgency === "HIGH" || review.rating <= 2;

  const updatedReview = await prisma.review.update({
    where: { id: review.id },
    data: {
      sentiment: ai.sentiment,
      urgency: ai.urgency,
      needsFollowUp: shouldFollowUp,
      summary: ai.summary,
      aiReply: ai.reply,
      status: shouldFollowUp ? "FOLLOW_UP" : "NEW"
    }
  });

  await prisma.usageEvent.create({
    data: {
      userId,
      businessId: business.id,
      eventType: "AI_REPLY_GENERATED",
      quantity: 1
    }
  });

  if (shouldFollowUp) {
    await prisma.task.create({
      data: {
        businessId: business.id,
        reviewId: review.id,
        title: `Follow up on ${review.rating}-star review`,
        description: ai.summary,
        priority: ai.urgency === "HIGH" ? "HIGH" : "MEDIUM"
      }
    });
  }

  return updatedReview;
}

