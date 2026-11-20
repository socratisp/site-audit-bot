# Site Audit Bot

A Telegram bot that audits websites and ranks them worst-first, so you know which local businesses to pitch.

## What it checks
- Google PageSpeed Insights: mobile and desktop performance, SEO, accessibility, LCP
- SSL validity and days until expiry, plus the HTTP→HTTPS redirect
- Server response time (TTFB)
- CMS detection (WordPress version), and the PHP version if the server exposes it
- Title, meta description, viewport, favicon, H1, image alt text
- Trackers loaded without a cookie banner (GDPR)
- Broken links on the homepage (first 25)
- Outdated copyright year

## Usage
- `/start`: the first person to send it becomes the owner. Everyone else is ignored.
- `/audit example.com`, or paste a single link: full report plus an opening line
- Paste several links, or upload a .csv/.txt file: batch run, ranked list plus a CSV

## Environment
| Var | Required | Notes |
|---|---|---|
| `BOT_TOKEN` | yes | from @BotFather |
| `PSI_API_KEY` | no | Google PageSpeed API key; without it you hit rate limits on big batches |
| `OWNER_ID` | no | your Telegram user ID; leave empty to lock the bot on first /start |

## Deploy (Docker)
`docker compose up -d --build`. On Hostinger VPS you can use Docker Manager → Compose from this repo URL.

## Local test
`npm install && node src/cli.mjs example.com`
