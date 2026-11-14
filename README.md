# NetForge

Local-first IT and network engineering toolbox.

NetForge is a collection of practical browser tools for systems administrators, network engineers and developers. Every tool runs entirely in your browser: nothing you paste or type is sent to a server.

**Status:** in development (v0.1.0-dev). Not released.

## Tools

Built:

- **Subnet Calculator**: network and broadcast addresses, subnet and wildcard masks, address counts and the usable host range for any IPv4 address and prefix, in CIDR or dotted-mask notation. /31 point-to-point links (RFC 3021), /32 host routes and /0 are handled as the special cases they are. Copy any value, or export the results as CSV or JSON.
- **JSON Formatter**: strict RFC 8259 validation with the exact line and column of any error, pretty-printing and minifying. Only whitespace changes: numbers, strings, escapes and duplicate property names are kept exactly as written, and integers too large for JavaScript are flagged instead of rounded.
- **Timestamp Converter**: Unix seconds, Unix milliseconds and ISO 8601 / RFC 3339 dates, shown in UTC and in any time zone. Local times that daylight saving time skips or repeats are reported as such instead of being silently shifted.

Planned: a subnet and VLAN planner, IP range and route summarization tools, cron and scheduling tools, encoders, hashing, a JWT decoder, regex and text tools, generators, and PowerShell and Terraform exports.

## Privacy

- All processing happens in the browser. There is no server component, no analytics, no cookies and no third-party scripts, fonts or other resources.
- The production build sets a Content-Security-Policy with `connect-src 'none'`, so the page cannot open network connections.
- Tool input stays in memory. Only display preferences (theme, last tool, time zone and JSON indentation) are saved in local storage; the About page lists them and clears them.
- After the first visit, a service worker keeps a copy of the app so it works offline.

## Development

Requires Node.js 24 and Google Chrome (the browser tests drive the installed Chrome).

```sh
npm install
npm run dev                  # development server
npm test                     # unit tests (Vitest)
npm run build                # type check and production build into dist/
npm run test:e2e             # browser tests against the production build (Playwright)
npm run test:all             # all of the above
node scripts/mutations.mjs   # mutation check of the unit suite
```

Test expectations come from sources independent of the code under test: Python's `ipaddress` and `zoneinfo` modules (`scripts/oracles/` regenerates `tests/fixtures/`), the JavaScript engine's own `JSON.parse` and `JSON.stringify`, `Date.prototype.toISOString`, and values worked out from the relevant RFCs and time zone rules.

The build uses relative paths, so `dist/` can be served from a site root or from a subpath such as `/netforge/`.

Published by RadMage Labs.
