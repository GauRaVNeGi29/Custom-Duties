# Going live on Render + Neon (free, no card)

About 1–2 hours. You need: a GitHub account, VS Code, and the Shopify CLI you already use.
Replace anything in CAPITALS.

| Part | Service | Cost |
| --- | --- | --- |
| App | Render free web service (0.1 CPU, 512 MB, 750 hours/month) | ₹0 |
| Database | Neon free (1 GB, 100 compute-hours/month) | ₹0 |
| Keep-awake ping | cron-job.org (free) | ₹0 |

---

## 1. Database: Neon

1. Sign up at **neon.tech** → **Create project** → name `setu-duties` → region **AWS US East (Ohio)**.
2. Click **Connect** and **turn off "Connection pooling"**.
3. Copy the connection string and add this to the end:
   ```
   &connection_limit=5&max_idle_connection_lifetime=60
   ```
   Final form:
   ```
   postgresql://neondb_owner:PASSWORD@ep-xxxx.us-east-2.aws.neon.tech/neondb?sslmode=require&connection_limit=5&max_idle_connection_lifetime=60
   ```
   The last part closes idle connections before Neon sleeps, so customers never hit a stale connection.

## 2. Put the project on GitHub (private)

Render deploys from a GitHub repository.

1. In VS Code, open the project folder → **Source Control** (left bar) → **Initialize Repository**.
2. Type a message such as `Setu Import Duties` → **Commit** (choose **Yes** to stage all changes).
3. Click **Publish Branch** → sign in to GitHub → choose **Publish to GitHub private repository**.
4. On github.com, open the repository and check:
   - `.env` is **not** there (it holds your database password – it's excluded automatically);
   - `package-lock.json` and `render.yaml` **are** there.

## 3. Production Shopify app

In the project folder (VS Code terminal):
```powershell
shopify app config link
```
Choose **Create a new app** → name **Setu Import Duties** → configuration name **production**. Then:
```powershell
shopify app config use shopify.app.toml
shopify app env show --config production
```
The first line keeps `npm run dev` on your development app. Note `SHOPIFY_API_KEY` and `SHOPIFY_API_SECRET` from the second.

## 4. Render

1. Sign up at **render.com** with your GitHub account (free plan).
2. **New → Blueprint** → connect GitHub → choose your repository. Render reads `render.yaml`.
3. Fill in the values it asks for:

   | Key | Value |
   | --- | --- |
   | `DATABASE_URL` | the Neon string from step 1 |
   | `SHOPIFY_API_KEY` | from step 3 |
   | `SHOPIFY_API_SECRET` | from step 3 |
   | `SHOPIFY_APP_URL` | `https://setu-duties.onrender.com` |

4. **Apply**. The first build takes 5–10 minutes.
5. Open the service → copy its address at the top. If it isn't exactly `https://setu-duties.onrender.com`
   (Render adds letters when a name is taken), go to **Environment**, set `SHOPIFY_APP_URL` to the real
   address and save. Use that address everywhere below.
6. Check: open `YOUR-APP-URL/healthz` in a browser – it should show `ok`.

## 5. Keep it awake (free)

Render's free plan sleeps after 15 minutes without visitors and takes about a minute to wake.
A ping every 10 minutes keeps it awake; a month needs 744 of the 750 free hours.

1. Sign up at **cron-job.org** (free).
2. **Create cronjob** → URL `YOUR-APP-URL/healthz` → every **10 minutes** → Save.

The ping doesn't touch the database, so Neon still sleeps when idle.

## 6. Point Shopify at Render

1. Open `shopify.app.production.toml`. Keep its `client_id` line and replace everything else with the
   contents of `deploy/shopify.app.production.toml.example`.
2. Replace `https://YOUR-APP-URL` (3 places) with your Render address.
3. Publish the settings and the cart widget:
   ```powershell
   shopify app deploy --config production
   ```
4. Commit and **Sync Changes** in VS Code so GitHub has the same file.

## 7. Install on Setu Store

1. **dev.shopify.com** → **Setu Import Duties** → **Distribution** → **Custom distribution**
   (permanent – choose custom, not public).
2. Enter `setustore.myshopify.com` → **Generate link**.
3. The store owner opens the link → **Install**.

## 8. Set up on the live store

1. **Apps → Setu Import Duties → Setup and rates → Sync all products.** The page updates by itself
   until it says "Product sync finished" (a few minutes for 10,000 variants).
2. **Destinations and currencies:** check USA, UK, Germany, Australia (all INR).
3. **Delete all rates**, then import `setustore_duty_rates_UK_USA_AUS_DE_2026-11.csv`.
4. **Products and HSN:** set HSN codes (bulk set, CSV, or copy from Shopify HS codes).
5. **Online Store → Themes → Customize → App embeds → Duties near checkout → On → Save.**
6. Fix the cart's **"Duties and taxes included"** line.
7. Run through the go-live checklist.

---

## Updating the app later

- Change code → **Commit** and **Sync Changes** in VS Code → Render redeploys automatically.
- Changed the cart widget or Shopify settings → also run `shopify app deploy --config production`.
- Logs: Render dashboard → **setu-duties** → **Logs**.

## Free-plan limits to know

- Render: 0.1 CPU, so admin pages are a little slower than on your laptop; 5 GB outbound
  data a month (the cart widget uses only a few KB per visit). Render describes its free plan as not
  meant for production – if Setu Store's traffic grows, the Starter plan (about US$7/month) removes the
  limits, and needs a card.
- Neon: 100 compute-hours a month; the database sleeps after 5 idle minutes.
- If anything is unavailable, the cart shows "estimate unavailable" and checkout stays open.
