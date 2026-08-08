# AutoForce Driver Hub
<p align="center"><img src="icons/logo-tile.png" alt="U.S. AutoForce" width="340"></p>

One app for the whole driver lifecycle. Combines **Quarterly Review** (ride-along evals), **New-Hire Training**, and **Certifications** — sharing the same local data stores as the standalone apps so everything stays in sync.

## Features

- **Quarterly Review** – ride-along scoring by category, driver notes, signature capture, records list, quarterly filters, and a trends/scorecard view.
- **New-Hire Training** – trainee roster, topic & milestone tracking (1-5 rating + comments), and a printable driver training record.
- **Certifications** – per-driver certs with expiry tracking, 90/30-day warnings, and a dashboard alert list.
- **Home dashboard** – quick actions and "needs attention" alerts across all three modules.

## Install

The Hub is a PWA — works in any modern browser and installs to your home screen.

- **Live site:** https://joshwheeler8206-cell.github.io/driver-hub/
- **Android APK:** download from the latest release below (signed, standalone app).
- **iPhone / iPad:** open the live site in Safari, tap **Share** → **Add to Home Screen** (fullscreen PWA; use Safari for the print/PDF buttons).

## Companion apps

- [Quarterly Review](https://joshwheeler8206-cell.github.io/driver-eval/) — standalone evals app
- [New-Hire Training](https://joshwheeler8206-cell.github.io/training-tracker/) — standalone training app
- [Cert Tracker](https://joshwheeler8206-cell.github.io/cert-tracker/) — standalone certifications app
- [Route Notes](https://joshwheeler8206-cell.github.io/route-notes/) — daily route notes

## Tech

Plain HTML/JS/CSS, no build step. Service worker caches assets for offline use. Data lives in the browser's IndexedDB (`usaf_driver_evals_db`, `usaf_training_db`, `usaf_cert_tracker_db`).
