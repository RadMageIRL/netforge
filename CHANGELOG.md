# Changelog

All notable changes to NetForge are recorded here. Versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

### 0.1.0-dev

Network planning:

- NetForge Subnet & VLAN Planner: sites, VRFs, VLAN namespaces and VLANs in one plan, with IPv4 and IPv6 networks, gateways, DHCP pools, reserved addresses, host targets, descriptions and notes, and optional parent blocks per site.
- Whole-plan validation with errors, warnings and notes at the affected field: VLAN IDs per namespace, overlaps per routing domain (independent VRFs may reuse networks), gateways, DHCP pools, reservations, capacity, IPv6 prefixes and gateways, parent blocks, and site, VRF and namespace references.
- Automatic IPv4 allocation from host targets through the VLSM engine, and a separate IPv6 prefix allocator (a /64 per VLAN by default); both previewed first, deterministic, and never replacing existing networks without confirmation.
- Address map: a zoomable grid for any IPv4 or IPv6 space, showing allocations, reservations, free space and conflicts, usable by keyboard and on phones.
- Plan files: versioned JSON saved and opened only on request, with clear errors for damaged or newer files; CSV export of VLAN tables and findings.
- The VLSM Allocator places blocks in one forward pass, so large plans allocate quickly (same placements as before).

Network engine:

- Subnet Calculator for IPv6 alongside IPv4 (IPv4 stays the default): RFC 4291 parsing, RFC 5952 canonical and expanded forms, /0 to /128, exact address counts, equal splits and supernets for both families.
- Address classification from the IANA IPv4 and IPv6 special-purpose address registries (updated 2025-10-09), bundled with the app.
- VLSM Allocator: deterministic IPv4 allocation with fixed allocations, reserved ranges, optional /31 and /32 sizing, failure reasons, free space and utilization.
- IP Range Analyzer: duplicates, containment, overlaps, gaps in a parent network and exact summaries, for IPv4 and IPv6.
- Route Summarization: the fewest exact routes per family, with any broader supernet shown separately.
- CSV and JSON export for every network tool.

Foundation:

- Application shell: tool navigation by category with search, keyboard shortcuts, a responsive layout with a drawer on small screens, a dark theme by default with a light theme, and an About page covering privacy and stored preferences.
- Subnet Calculator for IPv4, with copy and CSV and JSON export.
- JSON Formatter with strict validation, exact error locations and value-preserving formatting.
- Timestamp Converter for Unix seconds, Unix milliseconds and ISO 8601, with explicit time zones and daylight saving gaps and overlaps reported.
- Offline support through a service worker, and a Content-Security-Policy that blocks network connections from the page.
- Unit, oracle, mutation and browser test suites.
