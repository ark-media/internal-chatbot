This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

## Schema migrations

The transcripts/chunks pipeline schema is in `ingest/sql/001_init.sql` (applied via the Python ingest bootstrap). Subsequent migrations live alongside it:

- `ingest/sql/002_chat_history.sql` — `chats` + `chat_messages` for the saved-chats sidebar (7-day retention).

Apply manually:

```bash
psql "$DATABASE_URL" -f ingest/sql/002_chat_history.sql
```

The chat route handlers also self-heal via `ensureChatTables()` on first request, so a missed migration won't 500 — but applying explicitly avoids one slow cold-start request per Lambda.

The daily TTL purge runs at `app/api/cron/purge-chats` on the Vercel cron schedule in `vercel.json`. It requires `CRON_SECRET` in the environment; see `.env.example`.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.
