"""Expected time zone conversions from Python's zoneinfo, an implementation independent of the
browser's ICU. Writes tests/fixtures/time-oracle.json. Needs the tzdata package at the same IANA
release as the JavaScript runtime under test (Node 24.11 ships 2025b, which is tzdata==2025.2):

    pip install --target <dir> tzdata==2025.2
    PYTHONPATH=<dir> python scripts/oracles/time_oracle.py
"""
import json
from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

import tzdata

OUT = Path(__file__).resolve().parents[2] / "tests" / "fixtures" / "time-oracle.json"
ZONES = [
    "UTC", "America/New_York", "America/Los_Angeles", "America/St_Johns", "America/Sao_Paulo",
    "Europe/London", "Europe/Berlin", "Europe/Moscow", "Asia/Kolkata", "Asia/Kathmandu", "Asia/Tehran",
    "Australia/Sydney", "Australia/Lord_Howe", "Pacific/Chatham", "Pacific/Apia", "Pacific/Kiritimati",
]
START = datetime(1970, 1, 1, tzinfo=timezone.utc)
END = datetime(2030, 12, 31, tzinfo=timezone.utc)


def offset_seconds(t: datetime, zone: ZoneInfo) -> int:
    return int(t.astimezone(zone).utcoffset().total_seconds())


def transitions(zone: ZoneInfo):
    """Every instant in START..END where the zone's UTC offset changes, to the second."""
    found = []
    step = timedelta(hours=6)
    t = START
    prev = offset_seconds(t, zone)
    while t < END:
        nxt = t + step
        cur = offset_seconds(nxt, zone)
        if cur != prev:
            lo, hi = t, nxt
            while hi - lo > timedelta(seconds=1):
                mid = lo + (hi - lo) / 2
                mid = mid.replace(microsecond=0)
                if offset_seconds(mid, zone) == prev:
                    lo = mid
                else:
                    hi = mid
            found.append((hi, prev, cur))
            prev = cur
        t = nxt
    return found


def wall_iso(dt: datetime) -> str:
    return dt.strftime("%Y-%m-%dT%H:%M:%S")


def resolve(wall: datetime, zone: ZoneInfo) -> dict:
    """All instants whose local time in `zone` is `wall` (PEP 495 fold semantics)."""
    hits = set()
    for fold in (0, 1):
        aware = wall.replace(tzinfo=zone, fold=fold)
        ts = int(aware.timestamp())
        back = datetime.fromtimestamp(ts, zone).replace(tzinfo=None, fold=0)
        if back == wall:
            hits.add(ts)
    return {"wall": wall_iso(wall), "instants": sorted(t * 1000 for t in hits)}


instants = []
walls = []
for name in ZONES:
    zone = ZoneInfo(name)
    probes = set()
    t = START
    while t < END:
        probes.add(int(t.timestamp()))
        t += timedelta(days=113, hours=5, minutes=7, seconds=11)
    for when, before, after in transitions(zone):
        base = int(when.timestamp())
        for delta in (-3601, -1, 0, 1, 3599):
            probes.add(base + delta)
        local_before = (when + timedelta(seconds=before)).replace(tzinfo=None)
        local_after = (when + timedelta(seconds=after)).replace(tzinfo=None)
        lo, hi = min(local_before, local_after), max(local_before, local_after)
        middle = lo + (hi - lo) / 2
        for wall in {lo - timedelta(seconds=1), lo, middle.replace(microsecond=0), hi - timedelta(seconds=1), hi}:
            walls.append({"zone": name, **resolve(wall, zone)})
    for ts in sorted(probes):
        local = datetime.fromtimestamp(ts, zone)
        instants.append({"zone": name, "epochMs": ts * 1000, "wall": wall_iso(local), "offsetSeconds": int(local.utcoffset().total_seconds())})

OUT.parent.mkdir(parents=True, exist_ok=True)
OUT.write_text(json.dumps({"source": "python zoneinfo", "tzdata": tzdata.IANA_VERSION, "instants": instants, "walls": walls}, separators=(",", ":")) + "\n", encoding="utf-8", newline="\n")
kinds = {"exact": 0, "ambiguous": 0, "gap": 0}
for w in walls:
    kinds[{0: "gap", 1: "exact", 2: "ambiguous"}[len(w["instants"])]] += 1
print(f"tzdata {tzdata.IANA_VERSION}: {len(instants)} instants, {len(walls)} wall times {kinds} -> {OUT}")
