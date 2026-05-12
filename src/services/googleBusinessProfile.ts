import { env } from "../config/env.js";
import { HttpError } from "../utils/httpError.js";

const GOOGLE_SCOPE = "https://www.googleapis.com/auth/business.manage";

type GoogleTokenResponse = {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  token_type: string;
};

export type GoogleConnectionRecord = {
  id: string;
  userId: string;
  businessId: string;
  googleAccountName: string | null;
  googleLocationName: string | null;
  accessToken: string;
  refreshToken: string | null;
  tokenExpiresAt: Date | null;
};

export type GoogleAccount = {
  name: string;
  accountName?: string;
  type?: string;
};

export type GoogleLocation = {
  name: string;
  title?: string;
  storefrontAddress?: unknown;
  metadata?: {
    placeId?: string;
  };
};

export type GoogleReview = {
  name: string;
  reviewId: string;
  reviewer?: {
    displayName?: string;
    isAnonymous?: boolean;
  };
  starRating:
  | "ONE"
  | "TWO"
  | "THREE"
  | "FOUR"
  | "FIVE"
  | "STAR_RATING_UNSPECIFIED";
  comment?: string;
  createTime?: string;
  updateTime?: string;
  reviewReply?: {
    comment?: string;
    updateTime?: string;
  };
};

export function assertGoogleConfigured() {
  if (
    !env.GOOGLE_CLIENT_ID ||
    !env.GOOGLE_CLIENT_SECRET ||
    !env.GOOGLE_REDIRECT_URI
  ) {
    throw new HttpError(501, "Google Business Profile OAuth is not configured");
  }
}

export function buildGoogleAuthUrl(state: string) {
  assertGoogleConfigured();

  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", env.GOOGLE_CLIENT_ID!);
  url.searchParams.set("redirect_uri", env.GOOGLE_REDIRECT_URI!);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", GOOGLE_SCOPE);
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("state", state);
  return url.toString();
}

export async function exchangeGoogleCode(code: string) {
  assertGoogleConfigured();

  const body = new URLSearchParams({
    code,
    client_id: env.GOOGLE_CLIENT_ID!,
    client_secret: env.GOOGLE_CLIENT_SECRET!,
    redirect_uri: env.GOOGLE_REDIRECT_URI!,
    grant_type: "authorization_code",
  });

  return googleTokenRequest(body);
}

export async function refreshGoogleAccessToken(refreshToken: string) {
  assertGoogleConfigured();

  const body = new URLSearchParams({
    refresh_token: refreshToken,
    client_id: env.GOOGLE_CLIENT_ID!,
    client_secret: env.GOOGLE_CLIENT_SECRET!,
    grant_type: "refresh_token",
  });

  return googleTokenRequest(body);
}

export function tokenExpiresAt(expiresIn?: number) {
  if (!expiresIn) return null;
  return new Date(Date.now() + expiresIn * 1000);
}

export async function getUsableAccessToken(connection: GoogleConnectionRecord) {
  const expiresAt = connection.tokenExpiresAt?.getTime() ?? 0;
  if (connection.accessToken && expiresAt > Date.now() + 60_000) {
    return {
      accessToken: connection.accessToken,
      refresh: null as GoogleTokenResponse | null,
    };
  }

  if (!connection.refreshToken) {
    throw new HttpError(401, "Google connection needs to be re-authorized");
  }

  const refresh = await refreshGoogleAccessToken(connection.refreshToken);
  return {
    accessToken: refresh.access_token,
    refresh,
  };
}

export async function listGoogleAccounts(accessToken: string) {
  const data = await googleApi<{ accounts?: GoogleAccount[] }>(
    "https://mybusinessaccountmanagement.googleapis.com/v1/accounts",
    accessToken,
  );

  return data.accounts ?? [];
}

export async function listGoogleLocations(
  accessToken: string,
  accountName: string,
) {
  const url = new URL(
    `https://mybusinessbusinessinformation.googleapis.com/v1/${accountName}/locations`,
  );
  url.searchParams.set("readMask", "name,title,storefrontAddress,metadata");

  const data = await googleApi<{ locations?: GoogleLocation[] }>(
    url.toString(),
    accessToken,
  );
  return (data.locations ?? []).map((location) => ({
    ...location,
    name: location.name.startsWith("accounts/")
      ? location.name
      : `${accountName}/${location.name}`,
  }));
}

export async function listGoogleReviews(
  accessToken: string,
  locationName: string,
) {
  const url = new URL(
    `https://mybusiness.googleapis.com/v4/${locationName}/reviews`,
  );
  url.searchParams.set("pageSize", "50");
  url.searchParams.set("orderBy", "updateTime desc");

  const data = await googleApi<{
    reviews?: GoogleReview[];
    averageRating?: number;
    totalReviewCount?: number;
  }>(url.toString(), accessToken);

  return {
    reviews: data.reviews ?? [],
    averageRating: data.averageRating,
    totalReviewCount: data.totalReviewCount,
  };
}

export async function publishGoogleReviewReply(
  accessToken: string,
  reviewName: string,
  comment: string,
) {
  return googleApi<{ comment: string; updateTime: string }>(
    `https://mybusiness.googleapis.com/v4/${reviewName}/reply`,
    accessToken,
    {
      method: "PUT",
      body: JSON.stringify({ comment }),
    },
  );
}

export function googleStarRatingToNumber(
  starRating: GoogleReview["starRating"],
) {
  const ratings: Record<GoogleReview["starRating"], number> = {
    ONE: 1,
    TWO: 2,
    THREE: 3,
    FOUR: 4,
    FIVE: 5,
    STAR_RATING_UNSPECIFIED: 3,
  };

  return ratings[starRating] ?? 3;
}

async function googleTokenRequest(body: URLSearchParams) {
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!response.ok) {
    const errorBody = await response.text();
    console.error("Google token request failed:", response.status, errorBody);
    let errorMessage = `Google OAuth token request failed: ${response.status}`;

    try {
      const errorData = JSON.parse(errorBody);
      if (errorData.error_description) {
        errorMessage += ` - ${errorData.error_description}`;
      } else if (errorData.error) {
        errorMessage += ` - ${errorData.error}`;
      }
    } catch {
      errorMessage += ` - ${errorBody}`;
    }

    throw new HttpError(502, errorMessage);
  }

  return (await response.json()) as GoogleTokenResponse;
}

// Simple rate limiter to prevent quota exhaustion
const lastApiCall = new Map<string, number>();
const MIN_API_INTERVAL = 1100; // 1.1 seconds between calls

async function googleApi<T>(
  url: string,
  accessToken: string,
  init: RequestInit = {},
) {
  const now = Date.now();
  const lastCall = lastApiCall.get(url) || 0;
  const timeSinceLastCall = now - lastCall;

  if (timeSinceLastCall < MIN_API_INTERVAL) {
    const waitTime = MIN_API_INTERVAL - timeSinceLastCall;
    console.log(`Rate limiting: waiting ${waitTime}ms before API call`);
    await new Promise(resolve => setTimeout(resolve, waitTime));
  }

  lastApiCall.set(url, Date.now());

  const response = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      ...init.headers,
    },
  });

  if (!response.ok) {
    const errorBody = await response.text();
    console.error("Google API request failed:", response.status, errorBody);

    if (response.status === 429) {
      throw new HttpError(429, "Google API quota exceeded. Please wait a moment and try again.");
    }

    throw new HttpError(
      response.status === 401 ? 401 : 502,
      `Google Business Profile API request failed: ${response.status}`,
    );
  }

  return (await response.json()) as T;
}
