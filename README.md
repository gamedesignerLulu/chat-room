# Signal Room

A real-time chat site with accounts, image/gif sharing, and a full staff
moderation console — live IP bans, warnings, mutes, unmutes, unbans, a
theme changer, and an events board. Everything is persisted to `data.json`.

## What's inside

- `server.js` — Express + Socket.IO backend. All state lives in `data.json`.
- `data.json` — the database (users, messages, bans, warnings, events, settings).
- `public/index.html`, `public/style.css`, `public/script.js` — the frontend.
- `public/uploads/` — where uploaded images/gifs are stored.

## Running it locally

Requires [Node.js](https://nodejs.org) 18+.

```bash
npm install
npm start
```

Then open **http://localhost:3000**.

A seed admin account is created for you:

- **username:** `admin`
- **password:** `admin123`

**Change this password immediately** — either log in and (soon as you add
the feature) update it, or edit the `passwordHash` for the `admin` user in
`data.json` using a fresh bcrypt hash:

```bash
node -e "console.log(require('bcryptjs').hashSync('your-new-password', 10))"
```
Paste the output into `data.json` as that user's `passwordHash`.

## How accounts & staff work

Signal Room has a 5-level rank system: **user → mod → admin → dev → owner**.
Higher ranks can moderate/manage anyone below them, but never someone at or
above their own rank.

- Anyone can register from the login screen. New accounts get the `user` role.
- The seed account (`admin` / `admin123`) is created as **owner** — the top
  rank. Promote others from the Staff console → Users tab.
- **mod**: warn, mute/unmute, ban/unban, pin/delete messages, resolve reports.
- **admin**: everything mod does, plus manage channels, theme, effects,
  events, and promote/demote up to `mod`.
- **dev**: everything admin does, plus promote/demote up to `admin`, and an
  exclusive **Developer tab** with live server stats (uptime, memory, online
  count, totals).
- **owner**: full control, including appointing other `dev`/`owner` accounts,
  plus an exclusive **Owner tab** ("danger zone") to wipe all warnings, lift
  every active ban, or permanently delete an account.

Rank badges are small shield/crown icons next to a name (shield = mod,
shield+star = admin, shield+brackets = dev, crown = owner) — hover one to
see the person's custom staff title.

## Channels

The sidebar's Channels section lists all text channels. `admin`+ can create
or delete channels from Staff console → Channels. Messages, pins, and
history are all scoped per channel.

## Moderation features

- **Warn** — logs a warning and notifies the user.
- **Mute / Unmute** — blocks sending messages for a set duration (or
  indefinitely) without disconnecting the user.
- **Ban / Unban** — bans the user's most recently seen IP address. Any of
  their currently-connected sessions (on that account or that IP) are
  disconnected **immediately**, live, over the socket — not just on their
  next request.
- **Ban a raw IP** — from the Bans tab you can ban an IP address directly,
  even if it isn't tied to a specific account.
- Banned IPs are rejected before they can even load the page, register, or
  log in again.
- Every moderation action (and rank change) checks that the actor outranks
  the target — a mod can't touch an admin, an admin can't touch a dev, etc.

## Images & gifs

Click the 📎 button in the composer to upload an image, gif, png, jpeg, or
webp (8MB limit). It's stored in `public/uploads/` and shown inline in chat.

## Message actions (hover the ⋯ on any message)

- **Report** — available to everyone. Requires checking a confirmation box
  before it's sent. Reports land in the staff-only Reports tab with a live
  unread badge; staff can mark them resolved.
- **Pin** — staff only. Pinned messages show in a bar above the chat log,
  scoped per channel.
- **Delete** — staff only (can't be used on someone of equal/higher rank).
- **Change nickname** — staff only, lets a mod+ override a problematic
  nickname on someone else's account.

## Settings (everyone)

- Upload or remove a profile picture (shown everywhere instead of the
  default color avatar).
- Set a nickname, shown instead of your username throughout the site.

## Themes

Staff (`admin`+) can switch the site's look for **everyone** from the Staff
console's Theme tab, including three **animated** themes (aurora, nebula,
inferno) with slowly drifting colored gradients behind the whole UI, plus
four static themes. Add more by copying a `[data-theme="..."]` block in
`public/style.css`, adding matching `.theme-backdrop` rules, and an
`<option>` in `index.html`'s theme selector.

## Built-in events (site-wide effects)

Staff console → Effects tab triggers a live effect for everyone connected:
🪩 disco ball, 🎉 confetti, ❄️ snow, or 🌑 blackout. These are ephemeral
(not saved) — good for community events, celebrations, etc.

## Events board

Staff can post/delete events from the Staff console; they show up in
everyone's sidebar automatically, in real time.


## Deploying to a real host

This is a plain Node.js + Socket.IO app, so it runs on almost any host that
gives you a persistent Node process (Render, Railway, Fly.io, a VPS,
etc.) — it will **not** work as-is on a purely static host (e.g. GitHub
Pages), since it needs a server for the database, auth, uploads, and
WebSockets.

A few things to change before going live:

1. **Set a real `JWT_SECRET`** as an environment variable — don't rely on
   the built-in dev default:
   ```bash
   export JWT_SECRET="something long and random"
   ```
2. **Persist `data.json` and `public/uploads/`** on a persistent disk/volume.
   Many hosts wipe the filesystem on redeploy — make sure yours doesn't, or
   mount a volume for those two paths.
3. **IP addresses behind a proxy:** the server reads `X-Forwarded-For` if
   present. If you're behind a reverse proxy or platform load balancer,
   confirm it's actually setting that header, or IP bans will end up
   targeting the proxy's IP instead of the visitor's.
4. **HTTPS:** most hosts handle TLS termination for you; if you're running
   your own VPS, put this behind nginx/Caddy with a certificate.
5. Consider moving `data.json` to a real database (SQLite/Postgres) once
   you have meaningful traffic — a JSON file is easy to reason about but
   isn't built for high concurrency.

## Notes & limitations

- `data.json` writes are serialized in-process so concurrent actions don't
  corrupt the file, but this is still a single-file datastore — fine for a
  community-sized chat, not built for massive scale.
- Message history sent to clients on load is capped at the most recent 200
  messages (the file itself keeps the last 2000).
- There's no password-reset flow yet — if an account's password is lost,
  an admin needs to regenerate their `passwordHash` in `data.json` by hand
  (see the "change admin password" command above, adapted for that user).
