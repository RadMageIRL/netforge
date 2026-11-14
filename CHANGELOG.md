# Changelog

All notable changes to NetForge are recorded here. Versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

### 0.1.0-dev

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
