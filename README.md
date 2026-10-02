# U.S. AutoForce Driver Hub
<p align="center"><img src="icons/logo-tile.png" alt="U.S. AutoForce" width="340"></p>

One app for the whole driver lifecycle. Combines **Driver Review** (ride-along evals), **New-Hire Training**, and **Certifications** — sharing the same local data stores as the standalone apps so everything stays in sync.

## Features

- **Driver Review** – ride-along scoring by category, driver notes, signature capture, records list, quarterly filters, and a trends/scorecard view.
- **New-Hire Training** – trainee roster, topic & milestone tracking (1-5 rating + comments), and a printable driver training record.
- **Certifications** – per-driver certs with expiry tracking, 90/30-day warnings, and a dashboard alert list.
- **Driver Roster** – one profile per driver (Lic #, warehouse, phone, hire date, trainer) that autofills every AutoForce app. Type a **Driver License Expiration** or **Med Card Expiration** there and it is pushed straight into the Cert Tracker, so those dates show up on the expiring-cert reminder list and the home dashboard alerts automatically. Editing or clearing a date there keeps the cert tracker in step; certs you add by hand (hazmat, tanker, …) are never touched.
- **Home dashboard** – quick actions and "needs attention" alerts across all three modules.

## Install

The Hub is a PWA — works in any modern browser and installs to your home screen.

- **Live site:** https://joshwheeler8206-cell.github.io/driver-hub/
- **Android APK:** download from the latest release below (signed, standalone app).
- **iPhone / iPad:** open the live site in Safari, tap **Share** → **Add to Home Screen** (fullscreen PWA; use Safari for the print/PDF buttons).
- **Windows laptop:** download `AutoForce-Desktop-Apps-Setup.zip` from the latest release, unzip, double-click `install.bat`. It creates six desktop apps (this Hub plus the five standalone apps) in their own clean app windows with AutoForce icons. No admin rights needed, and they update themselves automatically.

## Moving your data between devices

Your records live in the browser **on the machine they were entered on** — nothing is uploaded anywhere. To move them (this PC → Windows laptop, laptop → phone, either direction):

1. On the old machine, open the Hub and scroll to the **Data & Reports** card → tap **Backup All (JSON)**. One file is saved to your Downloads folder, named `autoforce-data-YYYY-MM-DD.json`.
2. Copy that single file to the new machine — USB stick, email, or any cloud drive.
3. On the new machine, open the Hub → **Data & Reports** → **Restore / Add from Backup** → pick the file.
4. A summary shows how many records are in the file versus already on the device. **OK adds anything missing** (safe, deletes nothing); Cancel offers a full replace behind a second confirmation.

That one file covers all six apps: reviews, training records, certifications and expiry dates, PACE evaluations, route notes and the driver roster. Imports are matched on record id (roster on driver name), so re-importing the same file never creates duplicates, and older v1 backups still import. After an import the roster → cert-tracker expiry mirror is re-established automatically, so the two can never drift apart.

## Demo

See the Hub pre-loaded with sample data (5 drivers, reviews, training check-offs, certs, PACE, and routes):

- **Live demo:** https://joshwheeler8206-cell.github.io/driver-hub/demo/

## Companion apps

- [Quarterly Review](https://joshwheeler8206-cell.github.io/driver-eval/) — standalone evals app
- [New-Hire Training](https://joshwheeler8206-cell.github.io/training-tracker/) — standalone training app
- [Cert Tracker](https://joshwheeler8206-cell.github.io/cert-tracker/) — standalone certifications app
- [Route Notes](https://joshwheeler8206-cell.github.io/route-notes/) — daily route notes

## Tech

Plain HTML/JS/CSS, no build step. Service worker caches assets for offline use. Data lives in the browser's IndexedDB (`usaf_driver_evals_db`, `usaf_training_db`, `usaf_cert_tracker_db`, `usaf_roster_db`), all shared by origin with the five companion apps.
