# Terminal Security 5

Enterprise Discord security & moderation bot — **single file, zero setup**.

## Quick Start

```bash
npm install
cp .env.example .env   # fill in BOT_TOKEN and CLIENT_ID
node index.js          # starts bot AND deploys commands automatically
```

## .env

| Variable | Required | Description |
|----------|----------|-------------|
| `BOT_TOKEN` | ✅ | Your bot token from discord.com/developers |
| `CLIENT_ID` | ✅ | Your application's client ID |
| `GUILD_ID` | ⚡ Optional | Add for instant command registration (vs 1hr global) |
| `OWNER_ID` | — | Pre-set to `939620924213309451` — auto Rank 5 |

## Commands (60+)

**Global** — `/globalban`, `/globalmute`, `/globalkick`, `/unglobalban`, `/unglobalmute`, `/massglobalban`, `/massglobalmute`, `/massglobalkick`, `/requestban`, `/requestmute`, `/requestkick`, `/approvecase`, `/denycase`

**Moderation** — `/ban`, `/kick`, `/mute`, `/unmute`, `/warn`, `/unwarn`, `/softban`, `/unban`, `/tempban`, `/timeout`, `/untimeout`, `/clear`, `/history`, `/notes`, `/nickname`

**Admin** — `/adminset`, `/permissions`, `/about`, `/dm`, `/dmnotify`, `/userinfo`, `/serverinfo`, `/networkinfo`, `/approveguild`, `/denyguild`, `/listguilds`

**Security** — `/lock`, `/unlock`, `/slowmode`, `/checkban`, `/ghostban`, `/vckick`, `/stripall`, `/roleinfo`, `/channelinfo`, `/botstats`, `/invites`, `/rolemembers`, `/cleanup`, `/massrole`, `/lockdown`, `/unlockdown`, `/panic`, `/securityscan`, `/reputation`, `/trust`, `/untrust`, `/watchlist`

**Backup** — `/backup create|list|delete`

## Rank System

| Rank | Name |
|------|------|
| 5 | Network Owner (you) |
| 4 | Network Admin |
| 3 | Server Admin |
| 2 | Moderator |
| 1 | Helper |

Add admins: `/adminset add-admin @user rank:3`

## Channel Setup

`/adminset set-logs type:Event Logs channel:#your-channel`
`/adminset set-logs type:Welcome Channel channel:#welcome`
`/adminset set-logs type:Ban Logs channel:#ban-logs`
`/adminset set-logs type:Mod Logs channel:#mod-logs`
