# Brand assets

Visual identity for Orca Watchdog — the "industrial / CLI" direction (black orca
in a crosshair reticle with cyan signal waves, monospace wordmark).

| File | Size | Use |
|---|---|---|
| `orca-watchdog-banner.png` | 1536×508 | README hero (referenced from the top of [`../../README.md`](../../README.md)). |
| `orca-watchdog-social-preview.png` | 1280×640 | GitHub repository social preview — **set manually** (see below). |
| `orca-watchdog-logo-lockup.png` | 637×310 | Wordmark + tagline lockup, for slides / write-ups. |
| `orca-watchdog-icon-1024.png` | 1024×1024 | App/source icon (highest resolution). |
| `orca-watchdog-icon-512.png` | 512×512 | App/source icon. |
| `orca-watchdog-icon-256.png` | 256×256 | App/source icon. |

## Setting the GitHub social preview

The social-preview image can't be set from a committed file — it's uploaded in
the repo UI:

**Settings → General → Social preview → Edit → Upload an image**, then choose
`docs/assets/orca-watchdog-social-preview.png`.

## Note on the icon family

This project is a headless `launchd` / CLI daemon: there's no app bundle,
website, or PWA, so the functional icon slots (`favicon.ico`, `apple-touch-icon`,
`android-chrome-*`) have no surface that consumes them and are intentionally not
committed here. Only the high-resolution source icons are kept, as brand art for
any future use.
