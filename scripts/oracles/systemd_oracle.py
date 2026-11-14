"""Expected systemd calendar behavior from systemd itself. Writes tests/fixtures/systemd-oracle.json.

Runs inside a Linux system with systemd (checked with systemd 257 in Debian 13 under WSL):

    wsl.exe -d Debian -- python3 /mnt/e/code/NetForge/scripts/oracles/systemd_oracle.py

For every expression it records what `systemd-analyze calendar` accepts and its normalized form,
and for expression, zone (TZ) and base time combinations the next 10 elapse times in UTC, using
`--base-time=@<epoch>`. Deterministic: no "From now" values are kept.
"""
import calendar
import json
import os
import re
import subprocess
from datetime import datetime, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

OUT = Path(__file__).resolve().parents[2] / "tests" / "fixtures" / "systemd-oracle.json"
ITERATIONS = 10

# Inputs NetForge refuses on purpose although systemd accepts them, with NetForge's error code.
DESIGN_REJECTS = {
    "05:40:23.4200004/3.1700005": "fraction",
    "*-*-* 01:02:03.5": "fraction",
    "05:40:23.42/3.17": "fraction",
    "*-*-* 9:00 EST": "zone-abbreviation",
    "*-*-* 9:00 EDT": "zone-abbreviation",
    "*-*-* 09:00 GMT": "zone-abbreviation",
}

NORMALIZE = [
    # systemd.time(7), "Calendar Events" examples (the ones inside NetForge's subset).
    "Sat,Thu,Mon..Wed,Sat..Sun", "Mon,Sun 12-*-* 2,1:23", "Wed *-1", "Wed..Wed,Wed *-1", "Wed, 17:48",
    "Wed..Sat,Tue 12-10-15 1:2:3", "*-*-7 0:0:0", "10-15", "monday *-12-* 17:00", "Mon,Fri *-*-3,1,2 *:30:45",
    "12,14,13,12:20,10,30", "12..14:10,20,30", "mon,fri *-1/2-1,3 *:30:45", "03-05 08:05:40", "08:05:40", "05:40",
    "Sat,Sun 12-05 08:05:40", "Sat,Sun 08:05:40", "2003-03-05 05:40", "2003-02..04-05", "2003-03-05 05:40 UTC",
    "2003-03-05", "03-05", "hourly", "daily", "daily UTC", "monthly", "weekly", "weekly Pacific/Auckland", "yearly",
    "annually", "*:2/3", "minutely", "quarterly", "semiannually", "Mon *-05~07/1", "*-02~03",
    # Edge cases: shorthands in any case, weekday ranges, ranges and repetitions, end-of-month days, years, zones.
    "Mon-Fri", "Daily", "HOURLY", "Semiannually UTC", "*-*-* 05..05:00", "*-*-* 1..3,2:00", "*-*-* 03..01:00", "123-01-01",
    "0-01-01", "70-01-01", "69-01-01", "99-12-31", "00-01-01", "Mon *-*-* 00:00:00 Europe/Berlin", "monday", "mon..wed,fri",
    "*:0/15", "00/15:00", "Mon..Fri 9:00", "minutely UTC", "*-*-* 24:00", "*-*-* 23:59:60", "*-*-31", "02~03",
    "*-*~07..01/2", "*-*~01..07/2", "*-*~00", "*-*~32", "*-*-00", "*-13-01", "*-*-* 9:00 Z", "*-*-* 9:00 Foo/Bar",
    "Mon Tue", "Mon,,Tue", "*-*-* 1,,2:00", "9:00:00:00", "2026-*-* 9", "*-*-* 9:00 utc", "Sat..Sun", "Fri..Mon",
    "*-*-1/2", "*-1/0-1", "*-*-* 0/0:00", "*-*-* 0..23/25:00", "*-*-* 00:00:30/15", "*-*-* *:*:*", "*-*-* 9:*", "*:*",
    "12:30,15", "2199-*-*", "1970-01-01 00:00:00 UTC", "Mon *-*~07/1", "Mon *-05~07/1 12:00", "*-02-29",
    "*-*-* 9:00 America/new_york", "0..5", "*:*/15", "*-*-* */2:00", "*-*~03..01", "*-*~01..03", "12-10-15", "1969-01-01",
    "2200-01-01", "2199-12-31 23:59:59", "*-02-30", "Sat..Mon", "*-*-* 0..23/12:00", "*-*-* 0..10/5:00", "*-*-* 1..3/1:00",
    "*-*-* 5/30:00", "*:5/60", "*:0/1", "*-*-* 0..23/1:00", "*-*-* 0..23:00", "*:0..59", "*-*-* *:*:0..59", "*-*-* *:*:0/1",
    "*-*-* 3,1..2:00", "*-*-* 1..2,1..3:00", "*-*-* 1..3,1..2:00", "*-*-* 1/2,1:00", "*-*-* 1,1/2:00", "*-*-* 1..5/2,3:00",
    "2026..2030-*-*", "2026/2-*-*", "*-*-1..31", "*-1..12-*", "Mon,Tue,Wed,Thu,Fri,Sat,Sun", "Mon..Sun", "Sun,Mon",
    "Tue,Thu,Sat", "*-*~01", "*-*~01,03", "*-*~03,01", "*-*~01..01", "*-*~05/10", "*-*-* 9,09:00", "*-*-*", "*-*", "*",
    "Mon *", "*-*-* *", "*:*:*", "*-*-* 7:4:3", "2026-02-30", "Fri *-*-13", "*-01,04,07,10-01", "0/8:00", "*-*-* 23/2:00",
    "*-*-* 22/2:00", "*-*-31/1", "*-*~31/1", "*-*~01/1", "*-*~02/1", "*-*~05/4", "*-*~05/5", "*-*~10/5", "*-*~10/9",
    "*-*~30/1", "*-*~28/1", "*-*~01..07/3", "*-*~02..07/2", "*-*~01..06/2", "*-*-30/1", "*-*-29/2", "*-*-1/30", "*-*-1/31",
    "*-*-01..06/2", "0/23:00", "0/24:00", "1/22:00", "1/23:00", "*:0/59", "*:0/60", "*:59/1", "*:58/1", "2198/1-*-*",
    "2199/1-*-*", "1970/229-*-*", "1970/230-*-*", "*-1/11-*", "*-1/12-*", "*-12/1-*", "*-11/1-*", "*-*-* 0..23/24:00",
    "*-*-* 3..3/5:00", "*-*-* *:*:59/1", "*-*-* *:*:0/60", "*-*~29/1", "*-*~29", "*-*~30", "*-*~31", "*-*~29..30",
    "*-*~20/15", "*-*~20/19", "*-*~28/27", "*-*~28/28", "*-*~25/24", "*-*~27/26", "*-*~01..31", "*-*~01..31/30",
    "*-*~01..30/29", "*-02~31", "*-*-01..31/30", "Wednesday 12:00", "Thu..Sat,Mon 2027-*-* 23:59:59",
    "*-*-* 9:00 America/New_York", "*-*-* 9:00 Asia/Kolkata", "*-*-* 9:00 Etc/UTC", "Mon..Fri *-*-* 09:00:00 Europe/London",
    "*-*-* 25:00", "*-*-* 1:60", "*-*-32", "*-0-01", "1970-*-*", "*-*-* *:*:*/2", "Mo", "Tues", "@daily", "*/15 * * * *",
    "OnBootSec=15min", "15min", "1h 30min", "daily 09:00", "Mon..Fri UTC 09:00",
] + list(DESIGN_REJECTS)

GENERIC = [
    "*-*-* 02:30:00", "*-*-* 01:30:00", "*-*-* *:00/15:00", "*-*-* *:30:00", "*-*-* 02/1:00:00", "Mon..Fri 09:00",
    "*-*~01 23:59:00", "*-02-29 12:00", "Mon *-05~07/1", "*-*-31", "minutely", "*:*:00/20", "daily", "weekly", "monthly",
    "quarterly", "Sat,Sun *-*-* 01..02:00/30:00", "*-*~02/1 06:00", "*-*~01..07/3", "Fri *-*-13", "2199-12-31 23:59:59",
    "2199-*-* 00:00:00", "*-12-31 23:59:59", "*-*-* 9:00 America/New_York", "weekly Pacific/Auckland", "*-*-* 00:00:00 UTC",
    "Mon *-*-01..07 12:00", "*:*:*", "*-01,07-01 00:00", "2026..2030-02-29", "*-*-* 23:30:00", "12-25 00:00",
]
DST_EXPRS = [
    "*-*-* 02:30:00", "*-*-* 01:30:00", "*-*-* *:00/15:00", "*-*-* *:30:00", "*-*-* 02/1:00:00", "*-*-* 01..03:00/10:00",
    "minutely", "*-*-* 02:15:00", "*-*-* 01:45:00", "*-*-* 02:45:00", "*-*-* 03:30:00", "*-*-* 00/2:00:00", "hourly",
    "*-*-* *:*:00/30",
]
ZONES = ["UTC", "America/New_York", "Europe/London", "Australia/Lord_Howe", "Pacific/Auckland"]
GENERIC_BASES = [
    datetime(2026, 1, 31, 12, tzinfo=timezone.utc), datetime(2028, 2, 28, 12, tzinfo=timezone.utc),
    datetime(2026, 12, 31, 23, 30, tzinfo=timezone.utc), datetime(2199, 12, 30, tzinfo=timezone.utc),
]

ELAPSE = re.compile(r"^\s*(Next elapse|Iteration #\d+):\s*(.*)$")
IN_UTC = re.compile(r"^\s*\(in UTC\):\s*(.*)$")
STAMP = re.compile(r"^[A-Z][a-z]{2} (\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2}) UTC$")


def run(expr, zone="UTC", base=None, iterations=None):
    args = ["systemd-analyze", "calendar"]
    if iterations:
        args.append(f"--iterations={iterations}")
    if base is not None:
        args.append(f"--base-time=@{base}")
    args.append(expr)
    env = dict(os.environ, TZ=zone, LC_ALL="C")
    p = subprocess.run(args, capture_output=True, text=True, env=env)
    return p.returncode, p.stdout + p.stderr


def stamp_seconds(text):
    m = STAMP.match(text.strip())
    if not m:
        raise ValueError(f"unexpected timestamp {text!r}")
    y, mo, d, h, mi, s = map(int, m.groups())
    return calendar.timegm((y, mo, d, h, mi, s))


def elapses(output):
    """UTC epoch seconds of each elapse, preferring the "(in UTC)" line when systemd prints one."""
    out = []
    lines = output.splitlines()
    for i, line in enumerate(lines):
        m = ELAPSE.match(line)
        if not m:
            continue
        value = m.group(2).strip()
        if value == "never":
            break
        nxt = IN_UTC.match(lines[i + 1]) if i + 1 < len(lines) else None
        out.append(stamp_seconds(nxt.group(1) if nxt else value))
    return out


def normalized(output):
    for line in output.splitlines():
        if line.strip().startswith("Normalized form:"):
            return line.split(":", 1)[1].strip()
    return None


def transitions_2026(zone_name):
    zone = ZoneInfo(zone_name)
    off = lambda t: datetime.fromtimestamp(t, zone).utcoffset().total_seconds()
    t = calendar.timegm((2026, 1, 1, 0, 0, 0))
    end = calendar.timegm((2027, 1, 1, 0, 0, 0))
    out = []
    prev = off(t)
    while t < end:
        nxt = t + 3600
        cur = off(nxt)
        if cur != prev:
            lo, hi = t, nxt
            while hi - lo > 1:
                mid = (lo + hi) // 2
                if off(mid) == prev:
                    lo = mid
                else:
                    hi = mid
            out.append((hi, int(prev), int(cur)))
            prev = cur
        t = nxt
    return out


def main():
    version = subprocess.run(["systemd-analyze", "--version"], capture_output=True, text=True).stdout.splitlines()[0].strip()
    tzv = Path("/usr/share/zoneinfo/tzdata.zi").read_text().splitlines()[0].replace("# version", "").strip()

    seen = set()
    normalize_cases = []
    for expr in NORMALIZE:
        if expr in seen:
            continue
        seen.add(expr)
        # systemd reads a short zone name like EDT as the host's own abbreviation, so whether it is
        # accepted depends on the host's TZ; design rejects are checked on a New York host.
        tz = "America/New_York" if expr in DESIGN_REJECTS else "UTC"
        code, out = run(expr, tz)
        n = normalized(out)
        case = {"expr": expr, "accepted": code == 0 and n is not None, "normalized": n if code == 0 else None}
        if expr in DESIGN_REJECTS:
            case["netforgeRejectsByDesign"] = DESIGN_REJECTS[expr]
            case["tz"] = tz
        normalize_cases.append(case)

    elapse_cases = []
    combos = []
    for expr in GENERIC:
        for zone in ZONES:
            for base in GENERIC_BASES:
                combos.append((expr, zone, int(base.timestamp()), "generic"))
    for zone in ZONES:
        for at, before, after in transitions_2026(zone):
            overlap = before - after
            bases = [at - 4 * 3600, at - 30 * 60, at + 5 * 60]
            if overlap > 0:
                bases.append(at + overlap // 2)  # inside the second pass of the repeated hour
            for expr in DST_EXPRS:
                for b in bases:
                    combos.append((expr, zone, b, "gap" if after > before else "repeat"))
    for expr, zone, base, kind in combos:
        code, out = run(expr, zone, base, ITERATIONS)
        if code != 0:
            raise SystemExit(f"systemd-analyze failed for {expr!r} TZ={zone}: {out}")
        elapse_cases.append({"expr": expr, "zone": zone, "base": base, "kind": kind, "runs": elapses(out)})

    data = {
        "source": "systemd-analyze calendar", "systemd": version, "tzdata": tzv, "iterations": ITERATIONS,
        "baseStrictlyBefore": True, "normalize": normalize_cases, "elapses": elapse_cases,
    }
    OUT.write_bytes((json.dumps(data, separators=(",", ":")) + "\n").encode("ascii"))
    acc = sum(c["accepted"] for c in normalize_cases)
    print(f"{version}, tzdata {tzv}: {len(normalize_cases)} expressions ({acc} accepted), {len(elapse_cases)} elapse cases -> {OUT}")


if __name__ == "__main__":
    main()
