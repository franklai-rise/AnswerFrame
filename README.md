# AnswerFrame

**AnswerFrame — Visual AI Answer Library**

> Capture the answer. Keep every link.

AnswerFrame is a private, screenshot-first library for good AI answers. v1
captures one ChatGPT or Gemini web answer, keeps the preceding user question as
editable text, extracts source links, and shows those links in a position-aware
Source Rail beside the original screenshot. On Gemini, the adapter also reads
the visible **Sources** panel temporarily and closes it again before the capture
flow finishes.

## Repository layout

```text
apps/web          React + Vite cloud-library UI (Demo mode when Firebase is absent)
apps/extension    Manifest V3 ChatGPT + Gemini capture client
packages/shared   CaptureDraft/ClipRecord types and link/rail utilities
functions         Firebase Functions 2nd gen validator and cleanup triggers
firestore.rules   UID + answerframeOwner protected clip records
storage.rules     UID + image MIME/size protected screenshots
```

## Development

Requirements: Node.js 20+ and npm 10+.

```powershell
cd AnswerFrame
npm install
npm run test
npm run build
npm run dev
```

Open `http://localhost:5173/library`. With no `.env` values the app is an
intentional local Demo mode backed by browser IndexedDB (including long
screenshots); it is safe to use for visual and interaction work.

### Daily use without two terminals

The unpacked extension stays installed in Chrome after it is loaded once. The
web UI only needs its local HTTP server when the library is opened or a capture
is imported. After the first production build, install a per-user startup
shortcut:

```powershell
cd AnswerFrame
npm run build:web
npm run install:startup
```

This starts the local AnswerFrame server silently at Windows sign-in and opens
the library. When web source files change, run `npm run build:web`; when
extension files change, run `npm run build:extension`, click Reload on the
extension card, and refresh already-open ChatGPT/Gemini tabs once. To disable
the startup helper, delete `AnswerFrame.lnk` from the current user's Startup
folder.

## Firebase development project

Copy `.env.example` to `.env` and fill in a Firebase Web App configuration. Set
`VITE_FIREBASE_EMULATOR=true` while using the local emulators:

```powershell
npm run build:shared
npm run test:functions
npx firebase emulators:start --config firebase.json
```

The cloud layout is `users/{uid}/clips/{clipId}` with screenshot parts under
`users/{uid}/clips/{clipId}/`. Rules require both the authenticated UID and the
one-time `answerframeOwner` custom claim. Functions are pinned to
`asia-east1`; the production project must use a Blaze billing account with a
small budget alert before any real deployment. No deployment, claim grant, or
billing action is performed by this repository.

After a Google account has been created in the Firebase project, an operator
can grant the private-user claim once (using local Application Default
Credentials):

```powershell
npm run grant-owner -- owner@example.com
```

This command is intentionally never run by the development scripts.

The validator only checks public HTTP(S) URLs. It never forwards browser
cookies, Authorization headers, or page credentials. It rejects private and
metadata IP ranges before every redirect, allows at most five redirects, and
returns the stable `LinkStatus` contract documented in
`packages/shared/src/index.ts`.

## Public repository safety

This repository contains source code and synthetic demo content only. Keep
`.env`, Firebase service-account files, browser profiles, captured answers,
screenshots, and any production credentials outside Git. The checked-in
`.env.example` intentionally contains blank placeholders. Review the staged
file list before the first public push and rotate any credential immediately if
it was ever committed by mistake.

## Loading the extension locally

```powershell
npm run build:extension
```

In Chrome, open `chrome://extensions`, enable Developer mode, and choose
**Load unpacked** → `apps/extension/dist`. The daily-start helper keeps the
local web app available at `http://localhost:5173`; no terminal needs to remain
open. Whenever the extension is rebuilt, click **Reload** on its card and
refresh each already-open AI tab once. Version 0.2.1 temporarily uses Chrome's
local unlimited extension storage while handing a screenshot to the library;
the temporary transfer is removed as soon as the library preview confirms it.
The extension declares only ChatGPT and Gemini web pages (plus the local
development bridge), local `storage`/`unlimitedStorage`, `offscreen`, and
temporary `activeTab` capture access; it does not ask for all-site access,
cookies, history, or debugger access.

On a ChatGPT or Gemini page, each detected assistant/model answer receives
**Save to AnswerFrame**. The capture flow temporarily hides controls, captures
visible segments at least 550 ms apart, crops and stitches them, restores scroll
and focus in `finally`, then opens an in-page preview. Only after confirmation
does the extension open the library and forward the draft. After the database
write completes, the library shows a persistent **保存成功** confirmation with
the saved title and a direct **查看详情** action; a failed write leaves the
preview open so it can be retried. The first button visibly changes to
**正在截取回答…** and errors appear in a fixed toast on the AI page, so a failed
handoff is no longer silent. Gemini source links
  found in the answer and in its Sources panel are merged and de-duplicated while
  retaining a `sourceSurface` marker.

## Deliberate v1 boundaries

- ChatGPT and Gemini web pages only; Claude, Gemini in Chrome's side panel, and
  mobile apps are not included.
- Private account library; no public sharing, teams, OCR, AI summaries, or
  image annotation.
- No video or paper-body downloads. The screenshot and source metadata are the
  cloud content source.
- The current exact product name is a development name; check trademark,
  Chrome Web Store, and domain availability before public launch.
