# SAF Rental

The car rental app for the SAF partnership (Suhaib, Anees, Firos). It runs as a Google Apps Script web app, and its data lives in the Google Sheet **Rental Hub Data** in the Drive folder **SAF Rentals**.

**Open the app:** https://script.google.com/macros/s/AKfycbw4DwELqYZng48CLSiZ1qFM-d8S0UcV-7T4cddyFusD3blRddg1inJ2GjO49JhZTLByxQ/exec

Partners sign in with their name and PIN. To add it to an iPhone home screen, open the link in Safari → Share → Add to Home Screen.

This repository holds only the app's code. Customer details, trips, money, photos, agreements and statements stay in Google Drive and the Sheet, never here.

## Files

| File | What it is |
|---|---|
| `app/Code.gs` | Server side: sheet reads and writes, PIN sign-in, partner permissions, photos, PDFs, Telegram alerts |
| `app/Index.html` | The app itself: every screen, form, the English/Malayalam switch, and the preview with sample data |
| `app/version.json` | The version number and a short note about what changed |
| `app/appsscript.json` | Reference copy of the Apps Script manifest (permissions and web app settings). The updater never changes it. |

## Updating the app

1. Change `app/Code.gs` / `app/Index.html` and set the **same** version in `APP_VERSION` (top of `Code.gs`) and `app/version.json`. Push to `main`.
2. In Apps Script, paste the new `Code.gs` and `Index.html`, save, then **Deploy → Manage deployments → ✏️ → New version → Deploy**. The link never changes.

The installed version is shown at the bottom of **Partners → Team and settings**.

One-tap updates from GitHub were tried and removed: they need the Apps Script API, which Google keeps disabled in this project's hidden default Cloud project (moving to a standard Cloud project asked for payment verification). The code is in the git history (commit 0be4724) if it is ever wanted again.

## Full screen on Android

The files in the top folder (`index.html`, `manifest.webmanifest`, `sw.js` and the icons) are a small launcher served by GitHub Pages. It opens the app full screen with the SAF icon:

**https://ktsuhaib-debug.github.io/saf-rental-app/** → Chrome menu (⋮) → **Add to Home screen / Install app**.

iPhones go straight to the app link, because iOS already opens home-screen apps full screen.

## What the app does

- **Trips:** check-out with photos, ID proof and the customer's signature; check-in with an automatic bill (days, extra km, late fee, fuel, damage, FASTag tolls, fines); bookings for future dates on a 2-week calendar; enquiries with follow-up reminders.
- **Documents:** rental agreement PDF sent on WhatsApp; monthly partner statement PDF.
- **Customers:** history, Good/OK/Bad ratings, "do not rent".
- **Money:** income, expenses, dividends, cash handovers, car sales. Partners can add entries; saved entries are locked and only the admin can change them.
- **Fleet:** cars, investments per partner, insurance, PUC and tax expiry, service reminders, workshop status.
- **Partners:** settle-up, ownership, profit share, who is holding the cash, monthly split.
- **Other:** PIN sign-in, saving in the background, English/Malayalam, dd/mm/yyyy dates.
