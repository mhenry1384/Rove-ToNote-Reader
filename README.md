# Rove ToNote Reader

A small installable web app (PWA) for reading Rove ToNote documents
(`.tonote` files) on a phone or laptop. It is **read-only**: it never changes anything in your Drive.

- Opens `.tonote` files from Google Drive (every one in the root of My Drive, plus any others Drive's
  name search finds), or a file on the device.
- Shows the note tree with folders you can open and close. The filter box matches note titles and text.
- Shows every note type: Markdown, to-do lists (with priorities, item notes and a collapsed
  "Completed" section) and password grids (click a username or password to copy it).
- Encrypted notes unlock with the document password. The password and key are only kept in memory,
  and **Lock** forgets them.
- Works offline with the last opened copy. When it's open, it checks Drive for a newer version every
  couple of minutes and when you come back to the app.
- Follows the system light/dark setting with the same Alucard/Dracula colors as Rove ToNote.
- Note background colors and images are not shown.
- Plain HTML/CSS/JS with no build step. Markdown rendering uses the copies of `marked` and `DOMPurify`
  in `vendor/`.

## Google sign-in

The app asks for one scope, `drive.readonly`. Rove ToNote itself uses `drive.file`, which only lets an
app see files *that app* created, so this reader needs `drive.readonly` to see them.

`config.js` uses the same OAuth client as Rove Recipes. That client's consent screen already has
`drive.readonly`, and a GitHub Pages origin (`https://YOUR-GITHUB-USERNAME.github.io`) covers every repo
on that account, so nothing else needs to be set up for GitHub Pages. To test Drive locally, add
`http://localhost:8123` under **Authorized JavaScript origins** for that client in the Google Cloud
Console (**APIs & Services → Credentials**). Google's sign-in window will name the consent screen's app
("Rove Recipes"). If you'd rather it say something else, make a new OAuth client the same way as in the
Rove Recipes README and put its ID in `config.js`.

## Hosting on GitHub Pages

1. Create a GitHub repo (for example `Rove-ToNote-Reader`) and push this folder to it.
2. In the repo, go to **Settings → Pages → Build and deployment**, set Source to **Deploy from a
   branch**, and pick `main` / `/ (root)`.
3. The app will be at `https://YOUR-GITHUB-USERNAME.github.io/Rove-ToNote-Reader/`.

## Running locally

```
npx serve -l 8123 .
```
then open <http://localhost:8123>. `samples/Sample.tonote` has one of every note type; its encrypted notes
use the password `sample`. Rebuild it with `node tools/make-sample.mjs`.

## Installing the app

- **Windows / Mac (Chrome or Edge):** click the install icon in the address bar, or use the menu →
  *Install Rove ToNote Reader*. Once installed, Chrome and Edge can also open `.tonote` files with it.
- **Android (Chrome):** menu → *Add to Home screen* / *Install app*.
- **iPhone (Safari):** Share → *Add to Home Screen*.

## Releasing updates

Increase `APP_VERSION` in `version.js` on every push (1, 2, 3, ...). The number appears next to the app
name, and it also names the service-worker cache, so installed copies drop their old files.
