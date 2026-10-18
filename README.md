# SAF Rental

The car rental app for the SAF partnership (Suhaib, Anees, Firos). It runs as a Google Apps Script web app, and its data lives in the Google Sheet **Rental Hub Data** in the Drive folder **SAF Rentals**.

**Open the app:** https://script.google.com/macros/s/AKfycbw4DwELqYZng48CLSiZ1qFM-d8S0UcV-7T4cddyFusD3blRddg1inJ2GjO49JhZTLByxQ/exec

Partners sign in with their name and PIN. To add it to an iPhone home screen, open the link in Safari → Share → Add to Home Screen.

This repository holds only the app's code. Customer details, trips, money, photos, agreements and statements stay in Google Drive and the Sheet, never here.

## Files

| File | What it is |
|---|---|
| `Code.gs` | Server side: sheet reads and writes, PIN sign-in, partner permissions, photos, PDFs |
| `Index.html` | The app itself: every screen, form, the English/Malayalam switch, and the preview with sample data |

## Putting an update live

1. Open the Rental Hub Data sheet → **Extensions → Apps Script**.
2. Replace everything in `Code.gs` with this repository's `Code.gs`. Do the same for `Index.html`.
3. Save, choose the `setup` function and click **Run**. This is only needed when new columns or settings were added; running it again does no harm.
4. **Deploy → Manage deployments →** pencil icon **→ Version: New version → Deploy.** The app link stays the same.

## What the app does

- **Trips:** check-out with photos, ID proof and the customer's signature; check-in with an automatic bill (days, extra km, late fee, fuel, damage, FASTag tolls, fines); bookings for future dates on a 2-week calendar; enquiries with follow-up reminders.
- **Documents:** rental agreement PDF sent on WhatsApp; monthly partner statement PDF.
- **Customers:** history, Good/OK/Bad ratings, "do not rent".
- **Money:** income, expenses, dividends, cash handovers, car sales. Partners can add entries; saved entries are locked and only the admin can change them.
- **Fleet:** cars, investments per partner, insurance, PUC and tax expiry, service reminders, workshop status.
- **Partners:** settle-up, ownership, profit share, who is holding the cash, monthly split.
- **Other:** PIN sign-in, saving in the background, English/Malayalam, dd/mm/yyyy dates.
