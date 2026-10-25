# Security Policy

## Reporting a vulnerability

Please report security problems **privately** by email to **support@joelucky.io**. Do not open a public GitHub issue
for a vulnerability, because that would expose other players before a fix is available.

Useful details: the version (Settings → About), what you did, what you expected, what happened, and how serious you
think it is. Please **do not include your Gemini API key or any real chat logs** in a report; invented examples are
enough.

This is a personal project maintained in spare time. I will try to acknowledge a report within a few days, but I cannot
promise a fixed response or fix time.

## Scope

In scope: the local service (it listens on `127.0.0.1` only), the web interface, the launcher, API-key storage (Windows
DPAPI), cfg-file generation and the Portable package.

Out of scope: malware already running as your Windows user (it can already read your files), problems in third-party
services such as Google Translate or the Gemini API, and Counter-Strike 2 or Steam themselves.

## Supported versions

Only the latest release receives security fixes.

## How the app protects you (summary)

- The local service listens on `127.0.0.1` only, checks the `Host` and `Origin` headers, and requires a random
  per-start token for every API call.
- Your Gemini API key is encrypted with Windows DPAPI (current user), is never written in plain text, never appears on
  a command line or in logs, and is never included in the Portable package.
- Chat text is treated as untrusted data. Text written to the cfg file is sanitised, and nothing is sent to the game
  until you press your own key.
- The Portable build is not code-signed, so Windows SmartScreen may warn on the first run.

Other bugs and feature requests belong in [GitHub Issues](https://github.com/JoeJoe1024/cs2-chat-translator/issues).
