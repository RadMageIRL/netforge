# Changelog

All notable changes to NetForge are recorded here. Versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

### 0.1.0-dev

Infrastructure exports:

- A shared export model: every target returns files to review plus an account of each item as exact, approximate or unsupported, with assumptions, manual steps and what it never covers. Plans with validation errors are not exported, and nothing is run.
- PowerShell Generator: Windows DHCP Server scopes with exclusions, the router option, optional DNS options and reservations, created inactive by default and labeled as needing administrator rights; a read-only plan report script; a scheduled task example from the scheduling engine.
- Terraform Export: provider-neutral JSON, typed Terraform variables with HCL or JSON values, and an AWS VPC with subnets for hashicorp/aws that lists every incompatibility with the plan and writes no Availability Zones, routing or gateways.
- Cisco / Juniper Export: Cisco IOS / IOS-XE snippets (VLANs, SVIs, VRF membership, DHCP pools) and Juniper Junos `set` commands (VLANs, IRB interfaces, routing-instance membership), with the device context asked for instead of guessed, and no removing, saving or committing commands.
- The export tools can take a copy of the plan that is open in the planner, in memory only.

Remaining utilities:

- Number Bases & Bytes: exact conversion between binary, octal, decimal and hex, signed and unsigned at fixed, custom or unlimited widths, byte order views and exact storage unit conversion.
- chmod Calculator: check boxes, octal and symbolic forms with setuid, setgid and sticky, file and directory explanations, safe copyable commands, a preview of symbolic and numeric changes that follows GNU chmod, and a clear statement that NTFS ACLs are a different model.
- Every tool in the catalog is now built.

Engineering utilities:

- Base64 / URL / Hex: conversion between UTF-8 text, Base64, Base64URL, hex and URL percent-encoding in any direction, strict by default, with positions for malformed input, byte counts, explicit lenient and replacement options, and text or byte downloads.
- Hash / HMAC: SHA-256, SHA-384, SHA-512, legacy SHA-1 and MD5, and HMAC-SHA256/384/512 for text and files, in hex and Base64, with checksum comparison. Web Crypto for SHA and HMAC; a local RFC 1321 implementation for MD5.
- JWT Decoder: header and claims decoding, registered claim explanations, time claims checked against the device clock, expected issuer and audience checks, and optional signature verification for HS256/384/512, RS256/384/512 and ES256/384/512 with a supplied secret, PEM public key, JWK or pasted JWK Set. Algorithm confusion, `alg: none`, key-type and curve mismatches, malformed signatures, private keys and critical extensions are refused; keys are never fetched.
- Regex Tester: JavaScript regular expressions with highlighted matches, capture groups, named groups, zero-length matches, a replacement preview, and a two-second limit enforced by terminating and replacing the worker that runs the pattern.
- List / Text Tools: trim, remove empty and duplicate lines, change case, sort, prefix, suffix, number, list comparison and text statistics.
- UUID / Random Tokens: UUID versions 4 and 7 (RFC 9562) and random hex or Base64URL tokens in bulk, from the browser's secure generator only.
- YAML/XML Tools: YAML validation and formatting, YAML to JSON, JSON to YAML, XML validation, formatting and minifying, and XML to JSON with an explicit conversion model. The XML parser loads no external resources and expands no declared entities.
- One bundled dependency: the `yaml` parser, pinned to an exact version and loaded only in the YAML/XML worker.
- Input and output size limits for every utility, with oversized input refused rather than cut.

Scheduling (ScheduleForge):

- Cron Explainer for standard five-field cron (Vixie rules, including the day-of-month OR day-of-week rule and the AND case when a day field starts with *), Quartz cron (seconds, ?, L, L-n, LW, nW, nL, n#k, years to 2099) and systemd calendar expressions (weekdays, dates, times, repetitions, "~" end-of-month days, shorthands, time zones), each with its own parser; unsupported syntax is refused with the reason.
- Field-by-field explanations, warnings for common traps, the next 10 runs in a chosen time zone and UTC, DST changes in the next year that affect the schedule, and copy, CSV and JSON export.
- DST handling stated per scheduler: skipped and repeated local times are shown, marked with the observed systemd 257 behavior or as uncertain where cron daemons, Quartz or Windows Task Scheduler differ or do not document it.
- Schedule Builder: one schedule translated into standard cron, Quartz, systemd and Windows Task Scheduler (PowerShell and schtasks.exe), each labeled exact, approximate or unsupported, with differences, conditions, DST notes, each output's own next runs, and a systemd timer unit preview. Generated commands use safe quoting, keep placeholders for anything not supplied, request no credentials or elevation, and are never run.
- Bounded next-run search (400 years or the scheduler's last year, and a cap on candidate times), with a stated reason when fewer runs are found.

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
