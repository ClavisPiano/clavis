# Privacy

Clavis is a practice app. This page says what it keeps, where, who can see it and how to get rid of it. It is written in plain language and describes what the code does today.

## The short version

- Your practice stays on your device unless you create an account.
- An account has no email address, name or password. It is a passkey on your device.
- There is no advertising, no analytics and no tracking in the app.
- You can download your data and delete your account from Settings at any time.

## On your device

Clavis stores these in your browser (IndexedDB and local storage) and nowhere else until you sign in:

- Your practice history: which exercises you did, how you answered, your ratings and settings.
- Pieces you import, as scores.
- Benchmark recordings, if you make them. These are the only audio Clavis ever keeps.
- Small flags such as the last time you made a backup.

The microphone is used to hear what you sing or play. That audio is analysed on your device and thrown away. Only a benchmark recording that you choose to make is saved.

## If you create an account

Signing in turns on syncing. The server then holds:

- Your account: a random user id, when it was created, and for each passkey its public key, its id, a use counter, an optional name you gave it, when it was added and when it last signed you in. The private key never leaves your device.
- Your recovery codes, stored only as one-way hashes. Clavis cannot read them back.
- Your practice history: every event your devices send, including imported scores and your settings, kept in your own private store.
- Your benchmark recordings, kept in a private storage bucket under your user id.
- A session cookie in your browser that keeps you signed in for 30 days and is renewed while you use the app.

Limits apply to protect the service: up to 500,000 events or 256 MB of history, and 200 recordings or 500 MB.

## Practice reminders

If you turn reminders on, the server keeps, for each device, the push address your browser gave it, the keys needed to send you a notification, the time and days you chose, your time zone offset, your habit phrase, and the last day a reminder was sent or you practised. The notification is delivered through your browser vendor's push service, which sees that a notification was sent to your device.

## Who else is involved

Clavis runs on Cloudflare (hosting, a database, file storage and the event store). Cloudflare processes requests as any host does and may log things such as IP addresses under its own policies. Clavis does not store IP addresses itself. It uses your IP address only for a moment to limit how often the sign-in and recovery pages can be tried.

Clavis does not sell or share your data and does not use third party analytics or advertising.

## Keeping a copy

In Settings, Download my data gives you one JSON file with your account details, your full event history, a list of your recordings and your reminder settings. Passkey keys and push keys are left out. Recording audio is not in the file; the recordings are also on your device.

## Deleting your account

In Settings, Delete my account removes, from the server:

- your account, passkeys, recovery codes and sessions,
- your practice history,
- your recordings,
- your reminder settings.

It cannot be undone. Your device keeps its own copy of your practice, so you can keep using Clavis, and if you create a new account later your history is uploaded to it again. To remove the data on your device as well, clear this site's data in your browser settings.

Deleting is immediate. Copies in Cloudflare's own routine backups, if any, are outside the app's control and expire under Cloudflare's schedule.

## Changes and questions

If this page changes, the change shows in the project's history. Questions and requests can be raised as an issue on the project's repository (ClavisPiano/clavis).
