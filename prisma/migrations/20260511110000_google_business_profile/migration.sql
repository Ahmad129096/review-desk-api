-- Add Google Business Profile connection storage and review linkage.
ALTER TABLE "reviews"
ADD COLUMN "externalReviewId" TEXT,
ADD COLUMN "externalReviewName" TEXT,
ADD COLUMN "replyPublishedAt" TIMESTAMP(3);

CREATE UNIQUE INDEX "reviews_businessId_externalReviewName_key" ON "reviews"("businessId", "externalReviewName");

CREATE TABLE "google_connections" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "googleAccountName" TEXT,
    "googleLocationName" TEXT,
    "accessToken" TEXT NOT NULL,
    "refreshToken" TEXT,
    "tokenExpiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "google_connections_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "google_connections_businessId_key" ON "google_connections"("businessId");
CREATE INDEX "google_connections_userId_idx" ON "google_connections"("userId");

ALTER TABLE "google_connections" ADD CONSTRAINT "google_connections_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "google_connections" ADD CONSTRAINT "google_connections_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;
