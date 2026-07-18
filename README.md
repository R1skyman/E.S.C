# Tandem

A caregiving app for parents managing care for a child with disabilities — real-time
status on medications and routines, a shared household with real caregiver
permissions, and accessibility built in from the start.

This is the prototype, converted from a single-file Claude artifact into a real,
runnable project. The application logic hasn't changed — this just gives it a real
build pipeline so it can run in an actual browser, be handed to Claude Code for
further development, and eventually be deployed somewhere.

## Running it

You'll need [Node.js](https://nodejs.org) 18 or later installed.

```bash
npm install
npm run dev
```

Then open the URL it prints (usually `http://localhost:5173`). To try it on your
phone while developing, make sure your phone is on the same Wi-Fi network as your
computer, then use the "Network" URL Vite prints instead of "Local."

## What's real right now

- The full application — Today, Timeline, Household, Info Bank, Settings — all of it,
  running as an actual React app with a real build (Vite + Tailwind), not a
  chat-window artifact.
- Data persistence via `src/storage.js`, which uses the browser's own `localStorage`.
  This means your data lives on **one browser, on one device** — there's no sync
  between a parent's phone and a grandparent's tablet yet, and clearing your browser
  data clears the app's data too.

## What's still ahead

This is still a prototype in the most important sense: everything above is
single-device only. Before this could hold a real family's actual data, it needs:

- **A real backend** — accounts, a real database, and sync across devices. This is
  the biggest gap. `src/storage.js` is written so this swap is contained to one file
  — the rest of the app calls `window.storage.get/set/delete/list` and doesn't know
  or care what's actually storing the data.
- **Real push notifications** — right now, reminders only fire while the app is open
  in a browser tab. Background push (so a reminder can wake your phone from closed)
  needs a real backend to deliver from.
- **Legal review** — Terms of Service, a real Privacy Policy, and a security review
  scoped for children's health data, before any real family's information goes in.

## Project layout

```
src/
  App.jsx           — the root App component plus every screen and modal (still one
                      large file for the component tree itself — see below)
  constants.js      — CATEGORY_META, ROLE_META, color palettes, seed data
  storage.js        — the localStorage-backed persistence layer
  utils/
    status.js       — the urgency/countdown logic (getStatus, fmtCountdown, fmtElapsed)
    dateHelpers.js  — date/time formatting and the recurring-event rollover logic
    misc.js         — uid generation, phone formatting, history export text
    persistence.js  — the loadJSON/saveJSON wrappers around window.storage
  main.jsx          — React entry point
  index.css         — Tailwind + the app's own font/animation classes
```

Constants and pure helper functions are already split out into their own files —
that part's done, and verified working end-to-end (real bundling, real browser
render, a full click-through of Timeline, Household, Settings, and Quick Log).

What's still one big file is the component tree itself: `App.jsx` still holds every
screen and modal (Today, Timeline, Household, Info Bank, Settings, and all their
modals) in one file. Splitting each of those into its own file under
`src/screens/` and `src/components/` is a good next task — and a great one to hand
to Claude Code directly, since it's mechanical (move a function, add an import,
repeat) rather than risky. Point it at this file and the pattern is already
established by how `constants.js` and `utils/` were split out.
