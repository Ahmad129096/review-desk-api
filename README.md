# ReviewDesk API

Express, TypeScript, Prisma, PostgreSQL, JWT auth, OpenAI review automation, and Stripe checkout scaffolding for the ReviewDesk AI MVP.

## Setup

```bash
cd reviewdesk-api
pnpm install
cp .env.example .env
pnpm db:generate
pnpm db:push
pnpm dev
```

API health check:

```bash
GET http://localhost:4000/health
```

## MVP Routes

- `POST /api/auth/register`
- `POST /api/auth/login`
- `GET /api/auth/me`
- `GET /api/businesses`
- `POST /api/businesses`
- `PATCH /api/businesses/:id`
- `GET /api/reviews`
- `POST /api/reviews`
- `PATCH /api/reviews/:id/status`
- `GET /api/tasks`
- `PATCH /api/tasks/:id`
- `POST /api/billing/checkout`

If `OPENAI_API_KEY` is empty, the API uses a rule-based fallback so the MVP can still be tested locally.
