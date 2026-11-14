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

Planned: cron and scheduling tools, encoders, hashing, a JWT decoder, regex and text tools, generators, and PowerShell and Terraform exports.

## Privacy

- All processing happens in the browser. There is no server component, no analytics, no cookies and no third-party scripts, fonts or other resources.
- The production build sets a Content-Security-Policy with `connect-src 'none'`, so the page cannot open network connections.
- Tool input stays in memory. A network plan is written only to a file you choose to save, and read only from a file you pick: it is never stored in the browser and never restored on its own. Only display preferences (theme, last tool, time zone and JSON indentation) are saved in local storage; the About page lists them and clears them.
- The address registries are bundled with the app (`data/iana/`), so classification needs no network access.
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

Test expectations come from sources independent of the code under test: Python's `ipaddress` and `zoneinfo` modules (`scripts/oracles/` regenerates `tests/fixtures/`, including brute-force references for VLSM, IPv6 prefix allocation and plan validation), the JavaScript engine's own `JSON.parse` and `JSON.stringify`, `Date.prototype.toISOString`, and values worked out from the relevant RFCs, registries and time zone rules.

The classification data is generated from the IANA files in `data/iana/` by `node scripts/registry/build-registry.mjs`; the unit tests fail if the generated module and the files disagree.

The build uses relative paths, so `dist/` can be served from a site root or from a subpath such as `/netforge/`.

Published by RadMage Labs.
