import { env } from "../config/env.js";
import { z } from "zod";

export type ReviewAiResult = {
  sentiment: "POSITIVE" | "NEUTRAL" | "NEGATIVE";
  urgency: "LOW" | "MEDIUM" | "HIGH";
  needsFollowUp: boolean;
  summary: string;
  reply: string;
};

const reviewAiResultSchema = z.object({
  sentiment: z.enum(["POSITIVE", "NEUTRAL", "NEGATIVE"]),
  urgency: z.enum(["LOW", "MEDIUM", "HIGH"]),
  needsFollowUp: z.boolean(),
  summary: z.string().min(1),
  reply: z.string().min(1),
});

type GenerateInput = {
  businessName: string;
  industry: string;
  tone: string;
  rating: number;
  reviewText: string;
};

const fallbackReply =
  "Thank you for sharing your feedback. We appreciate you taking the time to tell us about your experience and will use it to improve.";

export async function generateReviewReply(
  input: GenerateInput,
): Promise<ReviewAiResult> {
  if (!env.OPENAI_API_KEY) {
    return {
      sentiment:
        input.rating <= 2
          ? "NEGATIVE"
          : input.rating === 3
            ? "NEUTRAL"
            : "POSITIVE",
      urgency: input.rating <= 2 ? "HIGH" : "LOW",
      needsFollowUp: input.rating <= 2,
      summary: "AI key is not configured, so a rule-based fallback was used.",
      reply: fallbackReply,
    };
  }

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: env.OPENAI_MODEL,
      temperature: 0.3,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            "You help local businesses respond to reviews. Return only valid JSON. Never blame the customer. Never promise compensation unless explicitly instructed.",
        },
        {
          role: "user",
          content: `Business name: ${input.businessName}
Industry: ${input.industry}
Preferred tone: ${input.tone}
Review rating: ${input.rating}
Review text: ${input.reviewText}

Return JSON with this exact shape:
{
  "sentiment": "POSITIVE | NEUTRAL | NEGATIVE",
  "urgency": "LOW | MEDIUM | HIGH",
  "needsFollowUp": true,
  "summary": "one sentence internal summary",
  "reply": "public reply text"
}`,
        },
      ],
    }),
  });

  if (!response.ok) {
    throw new Error(`OpenAI request failed: ${response.status}`);
  }

  const json = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = json.choices?.[0]?.message?.content;

  if (!content) {
    throw new Error("OpenAI returned an empty response");
  }

  const parsed = JSON.parse(content) as unknown;
  return reviewAiResultSchema.parse(parsed);
}
