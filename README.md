# SAF Rental

The car rental app for the SAF partnership (Suhaib, Anees, Firos). It runs as a Google Apps Script web app, and its data lives in the Google Sheet **Rental Hub Data** in the Drive folder **SAF Rentals**.

**Open the app:** https://script.google.com/macros/s/AKfycbw4DwELqYZng48CLSiZ1qFM-d8S0UcV-7T4cddyFusD3blRddg1inJ2GjO49JhZTLByxQ/exec

Partners sign in with their name and PIN. To add it to an iPhone home screen, open the link in Safari → Share → Add to Home Screen.

This repository holds only the app's code. Customer details, trips, money, photos, agreements and statements stay in Google Drive and the Sheet, never here.

## Files

| File | What it is |
|---|---|
| `app/Code.gs` | Server side: sheet reads and writes, PIN sign-in, partner permissions, photos, PDFs, self-update |
| `app/Index.html` | The app itself: every screen, form, the English/Malayalam switch, and the preview with sample data |
| `app/version.json` | The version number, a short note, and which files the app updates |
| `app/appsscript.json` | Reference copy of the Apps Script manifest (permissions and web app settings). The updater never changes it. |

## Updating the app (one tap)

1. Change `app/Code.gs` / `app/Index.html` and set the **same** version in `APP_VERSION` (top of `Code.gs`) and `app/version.json`. Push to `main`.
2. In the app, the admin opens **Partners → App updates → Check for updates → Update now**.

The app checks the files from GitHub, refuses anything incomplete, replaces its own code, creates a new version and moves the existing deployment to it, so the link above never changes. If a change ever needs a new permission, `appsscript.json` must be updated by hand and `setup` run once.

The app reads this private repository with a read-only GitHub token saved in the app (Script Properties), never in the code.

## Full screen on Android

The public repository `saf-rental` holds a small launcher page on GitHub Pages that opens this app full screen, with the SAF icon.

## What the app does

- **Trips:** check-out with photos, ID proof and the customer's signature; check-in with an automatic bill (days, extra km, late fee, fuel, damage, FASTag tolls, fines); bookings for future dates on a 2-week calendar; enquiries with follow-up reminders.
- **Documents:** rental agreement PDF sent on WhatsApp; monthly partner statement PDF.
- **Customers:** history, Good/OK/Bad ratings, "do not rent".
- **Money:** income, expenses, dividends, cash handovers, car sales. Partners can add entries; saved entries are locked and only the admin can change them.
- **Fleet:** cars, investments per partner, insurance, PUC and tax expiry, service reminders, workshop status.
- **Partners:** settle-up, ownership, profit share, who is holding the cash, monthly split.
- **Other:** PIN sign-in, saving in the background, English/Malayalam, dd/mm/yyyy dates.
