# NetForge

Local-first IT and network engineering toolbox.

NetForge is a collection of practical browser tools for systems administrators, network engineers and developers. Every tool runs entirely in your browser: nothing you paste or type is sent to a server.

**Status:** in development (v0.1.0-dev). Not released.

## Tools

Built:

- **Subnet Calculator** (IPv4 and IPv6): network boundaries, masks and exact address counts for any address and prefix. IPv4 handles /31 point-to-point links (RFC 3021), /32 host routes and /0 as the special cases they are. IPv6 accepts every standard text form, shows the RFC 5952 canonical and fully expanded forms, and never invents a broadcast address or IPv4-style usable-host counts. Also: address classification, splitting into equal subnets, and supernets. Copy any value, or export as CSV or JSON.
- **Address classification**: each address is checked against the IANA IPv4 and IPv6 special-purpose address registries (bundled, with their update dates), listing every matching block and its properties: private or local use, loopback, link-local, multicast and its scope, documentation, shared address space, benchmarking, reserved and others. "Globally reachable" is reported as the registry defines it, which is not the same as whether an address is routed on the Internet today.
- **VLSM Allocator**: divides an IPv4 network into right-sized subnets for named host counts, around fixed allocations and reserved ranges. Largest block first, each at the lowest free aligned address, so the same input always gives the same plan; requests that do not fit are reported with the reason. Optional /31 and /32 sizing for point-to-point links and single hosts.
- **NetForge Subnet & VLAN Planner**: plans sites, VRFs (routing domains), VLAN namespaces and VLANs, with IPv4 and IPv6 networks, gateways, DHCP pools, reserved addresses and host targets. The whole plan is checked as you type, and each finding is shown at the field it is about: VLAN IDs must be unique within a VLAN namespace (not per site, VRF or organization); networks must not overlap within a VRF or between VRFs that exchange routes, while reuse across independent VRFs is allowed and noted with the VRFs named; gateways, DHCP pools, reservations, capacity and optional site parent blocks are checked too. Automatic allocation fills IPv4 networks from host targets with the VLSM engine (across several parent blocks in order) and IPv6 prefixes, a /64 per VLAN by default, with exact counts and stated limits. Every allocation is previewed first, and networks that already exist are replaced only after you confirm. An address map shows any IPv4 or IPv6 space as a grid you can zoom into, with allocations, reservations, free space and conflicts. Plans are saved and opened as versioned JSON files; VLAN tables and findings export as CSV.
- **IP Range Analyzer**: finds duplicates, containment, partial overlaps and the gaps inside a parent network in a pasted list of CIDRs, addresses and ranges, IPv4 and IPv6, with problems reported by line number.
- **Route Summarization**: combines networks into the fewest exact routes without adding any address space, with IPv4 and IPv6 kept apart. A broader single supernet is shown separately, with the extra space it would cover.
- **JSON Formatter**: strict RFC 8259 validation with the exact line and column of any error, pretty-printing and minifying. Only whitespace changes: numbers, strings, escapes and duplicate property names are kept exactly as written, and integers too large for JavaScript are flagged instead of rounded.
- **Timestamp Converter**: Unix seconds, Unix milliseconds and ISO 8601 / RFC 3339 dates, shown in UTC and in any time zone. Local times that daylight saving time skips or repeats are reported as such instead of being silently shifted.
- **Cron Explainer**: reads standard five-field cron (Vixie cron as cronie and Debian cron follow it), Quartz cron and systemd calendar (`OnCalendar=`) expressions, each with its own parser and rules: one dialect is never read as another. Explains the expression and every field, warns about traps such as cron's day-of-month OR day-of-week rule, uneven steps and short months, and lists the next 10 runs in a chosen time zone and in UTC, with the zone's abbreviation and offset. Local times that a DST change skips or repeats are marked, with what that scheduler is known to do with them (systemd's behavior was checked against systemd 257; where cron daemons, Quartz or Windows differ or do not document it, the run is marked uncertain rather than predicted). Unsupported syntax is refused with the reason. Copy, CSV and JSON export.
- **Schedule Builder**: choose every N minutes, hourly, daily, weekdays, weekly or every N weeks, specific weekdays, or monthly (a date, the last day, or the first to fourth or last weekday), a time and a time zone, and get standard cron, Quartz, systemd and Windows Task Scheduler (PowerShell ScheduledTasks and `schtasks.exe`) versions. Each is labeled exact, approximate or unsupported; approximate versions list how their runs differ, unsupported ones say why, and every output states the conditions it relies on (such as the host's time zone) and how its scheduler handles DST. Each output's own next runs can be compared with the schedule. Optional names fill in the generated commands with safe quoting; without them the commands stay clearly marked templates. An optional systemd timer unit preview never invents the service it starts. NetForge never runs any command.

- **Base64 / URL / Hex**: converts between UTF-8 text, Base64, Base64URL, hexadecimal and URL percent-encoding in any direction, with byte counts. Strict by default: malformed Base64, hex, percent escapes and invalid UTF-8 are errors with their position, and nothing is repaired or replaced unless you turn on an option that says so. Decoded data that is not text can be downloaded as bytes.
- **Hash / HMAC**: SHA-256, SHA-384 and SHA-512, plus SHA-1 and MD5 labeled as legacy (MD5 is not suitable for anything security-sensitive), and HMAC-SHA256/384/512, for text or a file, in hex and Base64. SHA and HMAC come from the browser's Web Crypto API; MD5 is a small implementation of RFC 1321 checked against the RFC's test suite. Files are read and hashed on the device, in a worker. A published checksum can be pasted in to compare.
- **JWT Decoder**: decodes a JSON Web Token's header and claims, explains the registered claims, shows `exp`, `nbf` and `iat` as times, and checks them against the device clock and against an issuer and audience you expect. The signature can be verified with a key you supply (HS256/384/512 with a shared secret; RS256/384/512 and ES256/384/512 with a PEM public key, a JWK or a pasted JWK Set). Decoded, signature verified and claims checked are shown as three separate facts, and a verified signature is never presented as proof that a token is authorized. Unsupported algorithms, `alg: none`, key-type and curve mismatches, malformed signatures and private keys are refused, and a public key is never accepted as an HMAC secret. Keys are never fetched: `jku`, `x5u` and keys embedded in a token are ignored. Tokens and keys are never stored or put in the address bar.
- **Regex Tester**: JavaScript (ECMAScript) regular expressions, as this browser implements them, not PCRE or .NET. Highlighted matches, numbered and named capture groups, zero-length matches, match counts and a replacement preview. The pattern runs in a Web Worker under a two-second limit that is enforced by terminating the worker, so catastrophic backtracking cannot freeze the page. Output is bounded, and every limit that is reached is stated.
- **List / Text Tools**: trim, remove empty or duplicate lines, change case, sort (by character code, natural order or length), add prefixes and suffixes, number lines, compare two lists (intersection, differences, union) and count lines, words, characters and bytes. Case-sensitive or case-insensitive. With no operation selected the text is returned unchanged.
- **UUID / Random Tokens**: UUID version 4 and version 7 (RFC 9562) and random hex or Base64URL tokens of a chosen byte length, up to 1,000 at a time, from `crypto.getRandomValues` only. Shows the length and the number of random bits, and says what that number does and does not mean.
- **YAML/XML Tools**: validates and formats YAML (1.2) and XML, and converts YAML to JSON, JSON to YAML and XML to JSON. Formatting keeps comments, anchors, quoting and the spelling of numbers. Each conversion lists what the target format cannot hold (comments, aliases, non-string keys, layout whitespace) and refuses what would silently change meaning (infinity, duplicate keys). XML is read by NetForge's own parser, which loads no DTDs or external entities and expands no entities beyond the five built into XML; XML to JSON uses one explicit, documented model that keeps attributes, namespaces, comments and repeated elements in order.

Planned: number bases and byte units, a chmod calculator, and PowerShell and Terraform exports.

## Limits

Large inputs are refused with a message rather than cut or left to freeze the page: 8,000,000 characters for encoding, 512 MiB per file for hashing, 1,000,000 characters of text per regex run, 5,000,000 characters and 200,000 lines for text tools, 2,000,000 characters of YAML or JSON and 10,000,000 of XML. Hashing, regular expressions and YAML/XML processing run in workers with time limits.

## Privacy

- All processing happens in the browser. There is no server component, no analytics, no cookies and no third-party scripts, fonts or other resources.
- The production build sets a Content-Security-Policy with `connect-src 'none'`, so the page cannot open network connections.
- Tool input stays in memory. A network plan is written only to a file you choose to save, and read only from a file you pick: it is never stored in the browser and never restored on its own. Schedule expressions, task names and commands are never stored either, and neither are tokens, keys, secrets, hashed text or files, generated values or anything else entered in the utilities. Only display preferences (theme, last tool, time zone and JSON indentation) are saved in local storage; the About page lists them and clears them.
- The address registries are bundled with the app (`data/iana/`), so classification needs no network access.
- NetForge ships one third-party library, the `yaml` parser (ISC license, no dependencies of its own), bundled into the build at a pinned version and loaded only by the YAML/XML tool. Nothing is fetched at run time.
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

Test expectations come from sources independent of the code under test: Python's `ipaddress` and `zoneinfo` modules (`scripts/oracles/` regenerates `tests/fixtures/`, including brute-force references for VLSM, IPv6 prefix allocation and plan validation), the JavaScript engine's own `JSON.parse` and `JSON.stringify`, `Date.prototype.toISOString`, and values worked out from the relevant RFCs, registries and time zone rules. Scheduling is checked against Python's `croniter` (only where it follows Vixie cron), brute-force cron and Quartz references written from their documentation, `systemd-analyze calendar` from systemd 257, and Windows PowerShell's own parser and in-memory ScheduledTasks trigger objects (nothing is registered). The utilities are checked against published vectors (RFC 1321, RFC 4231, RFC 4648, RFC 7515, RFC 9562), Python's `hashlib`, `hmac`, `base64`, `urllib`, `uuid`, PyYAML and expat, tokens signed by the OpenSSL command line, and the JavaScript engine's own `String.prototype.replace`; the browser tests verify signatures made by Node's OpenSSL in Chrome's Web Crypto.

The classification data is generated from the IANA files in `data/iana/` by `node scripts/registry/build-registry.mjs`; the unit tests fail if the generated module and the files disagree.

The build uses relative paths, so `dist/` can be served from a site root or from a subpath such as `/netforge/`.

Published by RadMage Labs.
