---
name: cron
description: Manage opencodebot cron jobs in ~/.opencodebot/cron/jobs.json
compatibility: opencode
---

## Goal

Manage cron jobs for opencodebot by editing `~/.opencodebot/cron/jobs.json`.

## Storage

- Jobs file: `~/.opencodebot/cron/jobs.json`
- Run logs: `~/.opencodebot/cron/runs/<jobId>.jsonl` (read-only for this skill)

## Job schema

Each job item is a JSON object:

```json
{
  "id": "job_xxx",
  "schedule": "40 15 * * *",
  "target": {
    "guildId": "1467331665155330081",
    "channelId": "1467331666140860579",
    "threadId": null
  },
  "prompt": "提醒我要还信用卡",
  "systemPrompt": "",
  "createdAtMs": 0,
  "updatedAtMs": 0,
  "state": {
    "nextRunAtMs": 0,
    "lastRunAtMs": 0,
    "lastStatus": "idle"
  }
}
```

## Required behavior

1. Always preserve valid JSON array in `jobs.json`.
2. Support actions: add, list, update, remove.
3. For add:
   - validate cron expression format (strict 5 fields: `min hour day month weekday`)
   - do not use `@...` forms (forbidden)
   - one-shot datetime strings are forbidden (for example `@ 2026-02-14T08:20:00`)
   - if user says "今天16:20提醒..." convert to recurring cron by default: `20 16 * * *`
   - generate unique `id`
   - set `createdAtMs`/`updatedAtMs` to current epoch ms
   - set `state = { nextRunAtMs: 0, lastRunAtMs: 0, lastStatus: "idle" }`
   - if `systemPrompt` is absent, use `""`
4. For update:
   - update only requested fields
   - bump `updatedAtMs`
5. For remove:
   - delete by `id` only
6. Never delete unrelated jobs.
7. Return a concise result summary including affected job id(s).

## Valid schedule examples

- Every day 16:20: `20 16 * * *`
- Every workday 09:00: `0 9 * * 1-5`

## Session binding

When adding a job, bind `target.guildId/channelId/threadId` exactly to the values provided by the caller context.
