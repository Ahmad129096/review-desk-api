import type { Plan } from "@prisma/client";

export const planLimits: Record<Plan, number> = {
  FREE: 20,
  STARTER: 200,
  PRO: 1000,
  AGENCY: 5000
};

