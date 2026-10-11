# agent-core

Personal agent system: a core (Node + SQLite) with an HTTP/SSE API and a Hebrew RTL PWA used from the phone.

## Setup

```bash
npm install
npm run app:install && npm run app:build   # builds the PWA into app/dist
cp .env.example .env                       # then fill in the values below
npm start
```

In `.env`:
- `APP_ACCESS_TOKEN`: `openssl rand -hex 32`
- `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY`: `npx web-push generate-vapid-keys`
- `API_BIND_HOSTS`: `127.0.0.1` (add `tailscale ip -4` only if you want direct access by Tailscale IP; never `0.0.0.0`)

Do not set `ANTHROPIC_API_KEY`: agents run on the Claude subscription.

## Phone access (Tailscale)

Push notifications and PWA install require HTTPS. `tailscale serve` provides it and proxies to the core on localhost:

```bash
tailscale serve --bg --https=443 http://127.0.0.1:8787   # use your API_PORT
tailscale serve status                                   # shows https://<machine>.<tailnet>.ts.net
tailscale serve reset                                    # turn it off
```

Requirements: Tailscale on the computer and the phone, MagicDNS and HTTPS certificates enabled in the Tailscale admin console.

1. Open the `https://<machine>.<tailnet>.ts.net` address on the phone and enter the access token (stored on that device only).
2. Install to the home screen (iPhone: Safari → Share → Add to Home Screen; Android: Chrome → Install app).
3. Open the installed app → ⚙ → "הפעל התראות". On iPhone this only works from the installed app.

## Development

```bash
npm test            # core + app library tests
npm run typecheck
npm run app:dev     # Vite dev server, proxies API calls to 127.0.0.1:8787
```

## Registering a project

```bash
npm run project:add -- <name> <absolute repo path> [context file inside the repo]
```

The repository needs at least one commit. The context file (for example `CONTEXT.md`) is handed to the planner and the builder on every task.

## Acceptance check on the phone (M7)

The automated acceptance tests (`tests/acceptance.test.ts`) cover every criterion with a scripted stand-in for the agents. Two things only a real phone can show:

1. The approval alert arrives while the app is closed, and the reminders arrive after 10 and 20 minutes.
2. Tapping "אשר" in the app merges the task branch.
