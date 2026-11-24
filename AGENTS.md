# Agent instructions

## Git
- Never create a feature branch unless told to. Do all work directly on `main`.
- Increment `APP_VERSION` in `version.js` on every push. Versions are plain integers (v1, v2, v3, ...).
  The version is shown next to the app name so the user can confirm they are running the latest build,
  and it names the service-worker cache so installed copies pick up new files.

## Scope
- The app is read-only. It must never write to Google Drive or to `.tonote` files, and it only asks
  for the `drive.readonly` scope.
- The `.tonote` format is defined by Rove ToNote (`C:\Users\mhenr\Documents\Code\NodeJs\Rove ToNote`,
  see `src/document/`). Keep parsing in `app.js` in step with it.
