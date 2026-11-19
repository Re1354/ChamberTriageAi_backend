# ChamberTriage AI — Backend (API)

Fastify 5 + LangGraph.js (Interview ও Summarizer এজেন্ট) + Supabase (Postgres/Auth/Storage) + Gemini।
ফ্রন্টএন্ড: https://github.com/Re1354/ChamberTriageAi_frontend

## লোকালে চালানো
```bash
npm install
cp .env.example .env      # Windows: copy .env.example .env  → মান বসান
npm run db:migrate -- --seed   # প্রথমবার: Supabase-এ টেবিল (অথবা supabase/migrations/*.sql SQL Editor-এ)
npm run create-admin -- --email you@example.com --password "StrongPass123"
npm run dev               # http://localhost:4100/health
```
`MOCK_LLM=true` দিলে Gemini key ছাড়াই সব চলে। `MOCK_LLM=false` আর key খালি → AI বন্ধ, প্রশ্ন-ব্যাংক + নিয়ম-ভিত্তিক সামারি।

## Render-এ ডেপ্লয়
| ফিল্ড | মান |
|---|---|
| Build Command | `npm ci --include=dev && npm run build` |
| Start Command | `node --enable-source-maps dist/server.js` |
| Health Check Path | `/health` |
| Region / Plan | Singapore / Free |

Environment: `NODE_VERSION=22`, `NODE_ENV=production`, `DATABASE_URL` (Supabase **Session pooler**), `SUPABASE_URL`,
`SUPABASE_SERVICE_ROLE_KEY`, `MOCK_LLM=false`, `GEMINI_API_KEY` (ঐচ্ছিক), `ALLOWED_ORIGINS` (= Vercel URL),
`FRONTEND_URL`, `CRON_SECRET`, `IP_HASH_SALT` — বিস্তারিত `.env.example`-এ।

cron-job.org: `GET /health?db=1` প্রতি ১০ মিনিট; `POST /api/cron/cleanup` (হেডার `X-Cron-Secret`) প্রতিদিন।

> `shared/` ফোল্ডারটা ব্যাকএন্ড ও ফ্রন্টএন্ড — দুই রিপোতেই একই (API-র টাইপ/স্কিমা)। বদলালে দুই জায়গাতেই একই বদল দিন।
