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
apps/web          React + Vite library UI (also bundled as the extension-native library page)
apps/extension    Manifest V3 ChatGPT + Gemini capture client and local IndexedDB writer
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

### Daily use — no terminal or localhost required

The extension-native library is bundled into `apps/extension/dist`. Once the
unpacked extension has been loaded, click its toolbar icon to open the library;
it does **not** require `localhost`, a development server, a startup helper, or
an open terminal. All saved screenshots and metadata live in the extension
origin's IndexedDB in the current Chrome profile.

Chrome deliberately gives pixel-capture access only after an extension action
click. If a ChatGPT/Gemini answer asks you to click the AnswerFrame toolbar
icon, click it once: the pending answer resumes automatically. That one action
arms the current AI tab until it navigates or Chrome restarts; if no answer is
waiting, the same toolbar icon opens the library.

`npm run dev`, `npm run build:web`, and the optional startup scripts remain for
standalone web/Firebase development only. When extension source files change,
run `npm run build:extension`, click **Reload** on the extension card, and
refresh already-open ChatGPT/Gemini tabs once.

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
**Load unpacked** → `apps/extension/dist`. No local server is involved.
Whenever the extension is rebuilt, click **Reload** on its card and refresh
each already-open AI tab once. Version 0.3.3 captures the paired user question
and the complete selected answer, then stores preview-approved screenshot
pages directly in extension IndexedDB through an acknowledged Port sequence;
the metadata record is written only after every page has arrived. Interrupted
uploads have no visible clip record and stale chunks are cleaned up later. The
popup shows the latest content-free save stage without exposing the captured
answer, screenshot, question, or URLs.

The extension declares only the ChatGPT and Gemini web origins, local
`storage`/`unlimitedStorage`, `offscreen`, and temporary `activeTab` capture
access. It does not ask for all-site access, cookies, history, debugger access,
or a localhost bridge.

On a ChatGPT or Gemini page, each detected assistant/model answer receives
**Save to AnswerFrame**. The capture flow temporarily hides controls, captures
visible segments at least 550 ms apart, crops them into independent WebP pages,
restores scroll and focus in `finally`, then opens an in-page preview. Only
after that one confirmation does the extension save each page and atomically
create the clip in its own local library. On a newly opened/restarted AI tab,
Chrome may first ask for one toolbar-icon authorization; that click resumes the
pending answer automatically. It then opens the native library and the original
AI tab receives a visible success toast. A failed write leaves the preview open
and returns a visible error, so it can be retried. The first button visibly changes to
**正在截取问答…** and errors appear in a fixed toast on the AI page, so a failed
handoff is no longer silent. Gemini source links
  found in the answer and in its Sources panel are merged and de-duplicated while
  retaining a `sourceSurface` marker.

Click any screenshot in the capture preview or library detail page to open the
full-screen viewer. It supports mouse-wheel zoom, drag-to-pan, zoom controls,
double-click reset, page navigation, and `Esc` to close.

## Deliberate v1 boundaries

- ChatGPT and Gemini web pages only; Claude, Gemini in Chrome's side panel, and
  mobile apps are not included.
- Private account library; no public sharing, teams, OCR, AI summaries, or
  image annotation.
- No video or paper-body downloads. The screenshot and source metadata are the
  native local content source; Firebase remains an optional standalone/cloud
  development path, not the extension's daily save path.
- The current exact product name is a development name; check trademark,
  Chrome Web Store, and domain availability before public launch.
