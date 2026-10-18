# U.S. AutoForce Driver Hub
<p align="center"><img src="icons/logo-tile.png" alt="U.S. AutoForce" width="340"></p>

One app for the whole driver lifecycle. The Hub brings **Quarterly Review**, **PACE Evaluation**, **New-Hire Training**, **Certifications**, and **Route Notes** into a single screen, and shares the same local data stores as the standalone apps so everything stays in sync.

## Features

- **Quarterly Review** – ride-along scoring by category, driver notes, signature capture, records list, quarterly filters, and a trends/scorecard view.
- **PACE Evaluation** – the Plan Ahead / Analyze Surroundings / Communicate / Execute ride-along form with built-in stopwatches for eye lead, mirror intervals, and following distance. Prints on a single page.
- **New-Hire Training** – trainee roster, topic & milestone tracking (1-5 rating + comments), the full **62-item driver/trainer check-off**, digital sign-off pads, and a printable driver training record.
- **Certifications** – per-driver certs with expiry tracking, 90/30-day warnings, and a dashboard alert list.
- **Route Notes** – per-stop notes with C.O.D. and delivery instructions, ride-along notes, progress tracking, and a printable route report.
- **Driver Roster** – one profile per driver (Lic #, warehouse, phone, hire date, trainer) that autofills every AutoForce app. Type a **Driver License Expiration** or **Med Card Expiration** there and it is pushed straight into the Cert Tracker, so those dates show up on the expiring-cert reminder list and the home dashboard alerts automatically. Editing or clearing a date there keeps the cert tracker in step; certs you add by hand (hazmat, tanker, …) are never touched.
- **Home dashboard** – quick actions, a work-anniversaries card, and a clickable "Needs Attention" inbox that flags expired and expiring certifications, PACE drives that have come due, and training files still in progress — including the dangerous case of a driver on the road without a complete file.

## The new-hire process is gated

A new driver does not go on the road until their file is complete. Training runs in four sequential phases, and each one unlocks the next:

1. **Day 1–2 · Driver File & LMS** – LMS modules (including the 6 PACE modules), DQ file completed and submitted, road test in the truck type they will actually drive, working Samsara.
2. **Day 3 · Trainer Drives** – trainer drives with narrative PACE commentary.
3. **Day 4 · Trainee Drives** – trainee drives with the trainer, PACE eval drive and form.
4. **Day 5+ · Check-Off, Compliance & Release** – signed check-off and PACE form go to region compliance, compliance initials the items, and signs the **last signature** to release.

The banner on the driver's card reads **🚫 NOT CLEARED TO DRIVE** until the file is complete. Two of the phase-4 items are derived automatically from the record, so they cannot be ticked off by hand: the check-off must genuinely be fully signed, and the DOT Compliance signature must actually be present.

Assign a **region** (Central / West / East) and the correct region contacts print with the record.

## Records you can stand behind in an audit

- **Record IDs and timestamps** – every review, training record, and PACE evaluation carries an audit ID (`AF-REV-…`, `AF-TRN-…`, `AF-PACE-…`) plus created/updated timestamps. Records that predate the audit trail are stamped on load and flagged as migrated rather than re-dated.
- **Required fields are enforced** – a review or PACE form cannot be saved with the driver name or date missing. The offending fields highlight in red and the save is refused with a message listing exactly what is missing.
- **Signatures are locked** – once a signature pad has ink it locks, records the signing time, and cannot be quietly re-signed. Changing one requires an explicit **Void**, which demands a reason and writes it to a permanent log.
- **Check-off initials are real** – a two-to-three letter initial counts; a stray dot does not. The release gate uses the same rule, so the dot-hack cannot get a driver released.
- **PDFs tell the truth** – an incomplete file prints a red `PENDING — N of 62 check-off items still awaiting initials` banner with clean blank lines, rather than a document that looks finished. Complete files print a completion stamp. Every PDF carries the record ID and audit footnote.

## Reports and PDFs

Completed training and PACE evaluations save themselves as real PDFs named for the driver and the date — `AutoForce New Hire - Kyle Osei - 2026-06-01.pdf` — so they land in Downloads where you can find them later instead of vanishing into the app. Each one carries a one-tap **Email to Compliance Group** button (share sheet on a phone) alongside a **Save PDF** button. Nothing is pre-addressed to a personal inbox; set `window.AF_COMPLIANCE_EMAIL` before the app loads if you want the mail fallback pre-filled.

Release exports both PDFs at once (the training record and the linked PACE evaluation).

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
4. A summary shows how many records are in the file versus already on the device. **OK syncs the file onto the device** — it adds new records and updates any record the file has a newer version of, and never removes anything already on the device. Cancel offers a full replace behind a second confirmation, where the file wins outright.

That one file covers all six apps: reviews, training records, certifications and expiry dates, PACE evaluations, route notes and the driver roster. Imports are matched on record id (roster on driver name), so re-importing the same file never creates duplicates, and older v1 backups still import. After an import the roster → cert-tracker expiry mirror is re-established automatically, so the two can never drift apart.

Deleting a driver on your phone and then loading that phone's backup on the laptop will **not** delete them on the laptop — sync never removes anything. Backups are also automatic: each save writes a new timestamped file rather than overwriting the last one, and the auto-backup toggle lives in **Backup / Data**.

## Demo

See the Hub pre-loaded with sample data (5 drivers, reviews, training check-offs, certs, PACE, and routes):

- **Live demo:** https://joshwheeler8206-cell.github.io/driver-hub/demo/

## Companion apps

- [Quarterly Review](https://joshwheeler8206-cell.github.io/driver-eval/) — standalone evals app
- [PACE Evaluation](https://joshwheeler8206-cell.github.io/pace-eval/) — standalone PACE ride-along form
- [New-Hire Training](https://joshwheeler8206-cell.github.io/training-tracker/) — standalone training app
- [Cert Tracker](https://joshwheeler8206-cell.github.io/cert-tracker/) — standalone certifications app
- [Route Notes](https://joshwheeler8206-cell.github.io/route-notes/) — daily route notes

## Tech

Plain HTML/JS/CSS, no build step. Service worker caches assets for offline use. Data lives in the browser's IndexedDB, all shared by origin with the five companion apps:

`usaf_driver_evals_db`, `usaf_pace_eval_db`, `usaf_training_db`, `usaf_cert_tracker_db`, `usaf_route_notes_db`, `usaf_roster_db`

Reports are written by a small self-contained PDF module (`afreport.js`) with no external dependencies — no print dialog, no network.
