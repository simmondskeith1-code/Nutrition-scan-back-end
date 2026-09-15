# Nutrition Label Scanner Backend

One Vercel serverless function that reads a nutrition label photo using Claude's vision API
and returns calories/protein/carbs/fat as JSON.

## Setup

1. Push this repo (or this folder merged into your existing repo) to GitHub.
2. Go to vercel.com, sign in with GitHub, click "Add New Project," pick this repo.
3. Vercel auto-detects `/api/scan-label.js` — no build config needed, just deploy.
4. In the Vercel project dashboard: Settings > Environment Variables.
   Add `ANTHROPIC_API_KEY` with your key from console.anthropic.com.
   Redeploy after adding it (env vars only apply to new deployments).
5. Your live endpoint will be: https://<your-project-name>.vercel.app/api/scan-label

## Before going live with real users

- In scan-label.js, change `Access-Control-Allow-Origin: '*'` to your actual Movement
  platform domain. Left as '*' it works everywhere, including from anyone else's site
  who finds the URL and hammers your API key's usage/budget.
- Set spending limits/alerts on your Anthropic Console account so a bug or abuse doesn't
  produce a surprise bill.
  
