# SAF Rental

The car rental app for the SAF partnership (Suhaib, Anees, Firos).

It runs on **Cloudflare**: a Worker serves the app, the data is in a **D1** (SQL) database, and photos, ID proofs, signatures and PDFs are in **R2**. The Google Sheet **Rental Hub Data** stays as a read-only copy that refreshes every 5 minutes.

Partners sign in with their name and PIN. On Android: open the app link in Chrome → ⋮ → **Install app**. On iPhone: Safari → Share → **Add to Home Screen**.

This repository holds only the app's code. Customer details, trips, money, photos, agreements and statements are never committed here.

## Files

| Path | What it is |
|---|---|
| `src/worker.mjs` | The Worker: the app's API, photo and PDF links, the sheet copy, the one-time move |
| `src/app.mjs` | The business rules (trips, bookings, bills, partners, locking, Telegram). A line-by-line port of `app/Code.gs` |
| `src/store.mjs`, `src/schema.mjs` | D1 tables (one per old sheet tab, same columns) and saving |
| `public/index.html` | The app: every screen, English/Malayalam, the sample-data preview (`?demo=1`) |
| `public/pdfmaker.js`, `public/vendor/` | Makes the agreement and statement PDFs on the phone (pdf-lib, MIT licence) |
| `app/Code.gs`, `app/Index.html` | The old Apps Script app. Kept for the switch-over and as a fallback |
| `app/Cloudflare.gs` | Added to the Apps Script project: moves the data and Drive files once, then copies Cloudflare → sheet every 5 minutes |
| `tests/` | `npm test` (server), `tests/gs_check.mjs` (move + sheet copy), `tests/ui_check.py` (browser) |

## Setting it up (once)

1. **Cloudflare → R2**: turn R2 on (Cloudflare asks for a card; the free allowance is 10 GB).
2. **Workers & Pages → Create → Import a repository** → `saf-rental-app`, production branch `main`. Leave the build command empty; the deploy command is `npx wrangler deploy`. The first deploy creates the `saf-rental` database and the `saf-rental-files` bucket by itself.
3. **Apps Script** (the existing SAF Rental project): replace `Code.gs` with `app/Code.gs`, add a new script file `Cloudflare` with `app/Cloudflare.gs`. In Project Settings → Script Properties add `CF_URL` = the Worker's link (for example `https://saf-rental.suhaib-apps.workers.dev`). Run **cfMakeKey** and copy the key it shows.
4. **Cloudflare → saf-rental → Settings → Variables and Secrets → Add → Secret**: name `SYNC_KEY`, value the key from step 3.
5. **Apps Script**: run **cfCopyFiles** (again until it says "All files copied"), then **cfSwitchOver**. From then on the old link shows "SAF Rental has moved" with the new link, and the old app cannot save.

`cfReopenOldApp` undoes step 5 (anything entered in Cloudflare after that is not copied back). `cfSyncSheetNow` rewrites the whole sheet from Cloudflare.

## Updating the app

Change the code, test it, push to `main`. Cloudflare deploys it automatically. Keep `APP_VERSION` in `src/app.mjs` and `app/version.json` the same; the installed version is shown at the bottom of **Partners → Team and settings**.

Tests: `npm test`. To try the app locally with sample data: `node tests/serve.mjs` and open http://localhost:8787 (PINs 1111, 2222, 3333).

## What the app does

- **Trips:** check-out with photos, ID proof and the customer's signature; check-in with an automatic bill (days, extra km, late fee, fuel, damage, FASTag tolls, fines); bookings for future dates on a 2-week calendar; enquiries with follow-up reminders.
- **Documents:** rental agreement PDF sent on WhatsApp; monthly partner statement PDF.
- **Customers:** history, Good/OK/Bad ratings, "do not rent".
- **Money:** income, expenses, dividends, cash handovers, car sales. Partners can add entries; saved entries are locked and only the admin can change them.
- **Fleet:** cars, investments per partner, insurance, PUC and tax expiry, service reminders, workshop status.
- **Partners:** settle-up, ownership, profit share, who is holding the cash, monthly split, Telegram alerts.
- **Other:** PIN sign-in, saving in the background, English/Malayalam, dd/mm/yyyy dates.

## Notes

- Two partners saving at the same moment is safe: the second save is retried on fresh data, never written over the first.
- A save either goes through completely or not at all.
- Photo links in the app are signed and expire after a few hours. PDF links work for anyone who has them, like the old "anyone with the link" Drive files.
- The sheet is a copy. Typing in it does not change the app, and the next copy overwrites it.
