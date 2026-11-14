"""Expected cron and Quartz run times from implementations independent of NetForge. Writes
tests/fixtures/schedule-oracle.json. Deterministic (fixed seed). Needs croniter 6.0.0 and tzdata
at the same IANA release as the JavaScript runtime under test (Node 24.11 ships 2025b, which is
tzdata==2025.2):

    pip install --target <dir> croniter==6.0.0 tzdata==2025.2
    PYTHONPATH=<dir> python scripts/oracles/schedule_oracle.py

References:
- A brute-force day and second scanner written here from the Vixie cron rules (cron) and the
  Quartz CronExpression documentation (Quartz). It parses the expressions itself.
- croniter, for the expressions it models faithfully. It is never used for day fields where one
  starts with "*" but is restricted (croniter reads those with OR, Vixie cron with AND), nor for
  Quartz features it lacks (L-n, LW, nW, the year field).
- Python zoneinfo for DST: every scheduled wall time is resolved with fold=0 and fold=1.
"""
import json
import random
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

import croniter as croniter_module
import tzdata
from croniter import croniter

OUT = Path(__file__).resolve().parents[2] / "tests" / "fixtures" / "schedule-oracle.json"
EPOCH = datetime(1970, 1, 1)
RUNS = 8
DST_COUNT = 10
MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"]
DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"]


def is_leap(y):
    return (y % 4 == 0 and y % 100 != 0) or y % 400 == 0


def dim(y, m):
    if m == 2:
        return 29 if is_leap(y) else 28
    return 30 if m in (4, 6, 9, 11) else 31


def dow0(y, m, d):
    """0 = Sunday."""
    return (date(y, m, d).weekday() + 1) % 7


def epoch_s(dt):
    return int((dt - EPOCH).total_seconds())


# ---- Vixie cron, parsed independently ------------------------------------------------------

CRON_NICK = {"@yearly": "0 0 1 1 *", "@annually": "0 0 1 1 *", "@monthly": "0 0 1 * *", "@weekly": "0 0 * * 0",
             "@daily": "0 0 * * *", "@midnight": "0 0 * * *", "@hourly": "0 * * * *"}
CRON_SPEC = [(0, 59, None), (0, 23, None), (1, 31, None), (1, 12, MONTHS), (0, 7, DAYS)]


def cron_num(text, lo, names):
    if text.isdigit():
        return int(text)
    return names.index(text.lower()) + (1 if names is MONTHS else 0)


def cron_parse(expr):
    text = CRON_NICK.get(expr.strip().lower(), expr)
    parts = text.split()
    assert len(parts) == 5, expr
    sets = []
    stars = []
    for (lo, hi, names), field in zip(CRON_SPEC, parts):
        stars.append(field.startswith("*"))
        values = set()
        for item in field.split(","):
            base, _, step = item.partition("/")
            step = int(step) if step else 1
            if base == "*":
                a, b = lo, hi
            elif "-" in base:
                x, y = base.split("-")
                a, b = cron_num(x, lo, names), cron_num(y, lo, names)
            else:
                a = b = cron_num(base, lo, names)
            values.update(range(a, b + 1, step))
        sets.append(values)
    minutes, hours, doms, months, dows = sets
    if 7 in dows:
        dows = (dows - {7}) | {0}
    and_rule = stars[2] or stars[4]

    def day_ok(y, m, d):
        if m not in months:
            return False
        a = d in doms
        b = dow0(y, m, d) in dows
        return (a and b) if and_rule else (a or b)

    times = sorted(h * 3600 + mi * 60 for h in hours for mi in minutes)
    return day_ok, times, (lambda y: True), 9999


# ---- Quartz, parsed independently ------------------------------------------------------------

Q_SPEC = [(0, 59, None), (0, 59, None), (0, 23, None), (1, 31, None), (1, 12, MONTHS), (1, 7, DAYS), (1970, 2099, None)]


def q_num(text, names):
    if text.isdigit():
        return int(text)
    return names.index(text.lower()) + 1


def q_list(field, lo, hi, names):
    values = set()
    for item in field.split(","):
        base, _, step = item.partition("/")
        step = int(step) if step else 1
        if base == "*":
            a, b = lo, hi
        elif "-" in base:
            x, y = base.split("-")
            a, b = q_num(x, names), q_num(y, names)
        else:
            a = q_num(base, names)
            b = hi if step_given(item) else a
        values.update(range(a, b + 1, step))
    return values


def step_given(item):
    return "/" in item


def nth_weekday(y, m, dow, n):
    first = dow0(y, m, 1)
    d = 1 + (dow - first) % 7 + (n - 1) * 7
    return d if d <= dim(y, m) else None


def last_weekday(y, m, dow):
    last = dim(y, m)
    return last - (dow0(y, m, last) - dow) % 7


def quartz_parse(expr):
    parts = expr.split()
    assert len(parts) in (6, 7), expr
    sec = q_list(parts[0], 0, 59, None)
    mins = q_list(parts[1], 0, 59, None)
    hrs = q_list(parts[2], 0, 23, None)
    months = q_list(parts[4], 1, 12, MONTHS)
    years = q_list(parts[6], 1970, 2099, None) if len(parts) == 7 else None
    dom, dow = parts[3].upper(), parts[5].upper()
    if dom != "?":
        if dom == "L":
            rule = lambda y, m, d: d == dim(y, m)
        elif dom.startswith("L-"):
            off = int(dom[2:])
            rule = lambda y, m, d: d == dim(y, m) - off
        elif dom == "LW":
            def rule(y, m, d):
                last = dim(y, m)
                w = dow0(y, m, last)
                return d == (last - 1 if w == 6 else last - 2 if w == 0 else last)
        elif dom.endswith("W"):
            target = int(dom[:-1])

            def rule(y, m, d):
                w = dow0(y, m, target)
                t = target
                if w == 6:
                    t = 3 if target == 1 else target - 1
                elif w == 0:
                    t = target - 2 if target == dim(y, m) else target + 1
                return d == t
        else:
            ds = q_list(dom, 1, 31, None)
            rule = lambda y, m, d: d in ds
    else:
        if dow == "L":
            rule = lambda y, m, d: dow0(y, m, d) == 6
        elif dow.endswith("L"):
            n = q_num(dow[:-1], DAYS) - 1
            rule = lambda y, m, d: d == last_weekday(y, m, n)
        elif "#" in dow:
            a, k = dow.split("#")
            n = q_num(a, DAYS) - 1
            k = int(k)
            rule = lambda y, m, d: d == nth_weekday(y, m, n, k)
        else:
            ws = {v - 1 for v in q_list(dow, 1, 7, DAYS)}
            rule = lambda y, m, d: dow0(y, m, d) in ws

    def day_ok(y, m, d):
        return m in months and rule(y, m, d)

    times = sorted(h * 3600 + mi * 60 + s for h in hrs for mi in mins for s in sec)
    year_ok = (lambda y: y in years) if years is not None else (lambda y: True)
    return day_ok, times, year_ok, 2099


def parse(dialect, expr):
    return cron_parse(expr) if dialect == "cron" else quartz_parse(expr)


def brute_runs(dialect, expr, start, n, horizon_years=400):
    """Up to n runs strictly after `start` (epoch seconds), in UTC, scanning day by day."""
    day_ok, times, year_ok, last_year = parse(dialect, expr)
    st = EPOCH + timedelta(seconds=start)
    limit = min(last_year, st.year + horizon_years)
    d = st.date()
    out = []
    while len(out) < n and d.year <= limit:
        if year_ok(d.year) and day_ok(d.year, d.month, d.day):
            base = datetime(d.year, d.month, d.day)
            for t in times:
                dt = base + timedelta(seconds=t)
                if dt > st:
                    out.append(epoch_s(dt))
                    if len(out) == n:
                        break
        if d == date(9999, 12, 31):
            break
        d += timedelta(days=1)
    return out, limit, last_year


def has_dates_in_cycle(dialect, expr):
    day_ok, _, _, _ = parse(dialect, expr)
    d = date(2000, 1, 1)
    while d < date(2400, 1, 1):
        if day_ok(d.year, d.month, d.day):
            return True
        d += timedelta(days=1)
    return False


def expected_stop(dialect, expr, start, found, n, limit, last_year):
    """What NetForge should report when it finds fewer than n runs (documented in search.ts)."""
    if found >= n:
        return None
    if found == 0 and not has_dates_in_cycle(dialect, expr):
        return "never"
    _, _, year_ok, _ = parse(dialect, expr)
    st_year = (EPOCH + timedelta(seconds=start)).year
    if found == 0 and not any(year_ok(y) for y in range(st_year, last_year + 1)):
        return "past"
    if limit == last_year:
        return "last-year"
    return "never" if found == 0 else "horizon"


def croniter_runs(text, start, n, seconds=False):
    st = EPOCH + timedelta(seconds=start)
    try:
        it = croniter(text, st, second_at_beginning=True) if seconds else croniter(text, st)
        return [epoch_s(it.get_next(datetime)) for _ in range(n)]
    except Exception as e:  # croniter's "failed to find next date" and the like
        return f"error: {type(e).__name__}"


# ---- Random expressions ------------------------------------------------------------------------

def rand_value(rng, lo, hi, names, name_chance=0.4):
    v = rng.randint(lo, hi)
    if names is not None and rng.random() < name_chance:
        idx = v - (1 if names is MONTHS else 0)
        if 0 <= idx < len(names):
            name = names[idx]
            return rng.choice([name, name.upper(), name.capitalize()]), v
    return str(v), v


def rand_cron_field(rng, lo, hi, names, dense=False):
    k = 1 if rng.random() < 0.65 else rng.randint(2, 3)
    items = []
    for _ in range(k):
        r = rng.random()
        if k == 1 and r < (0.35 if dense else 0.15):
            items.append("*")
        elif r < 0.30:
            items.append(f"*/{rng.randint(2, max(2, min(hi - lo, 20)))}")
        elif r < 0.60:
            items.append(rand_value(rng, lo, hi, names)[0])
        else:
            a = rng.randint(lo, hi - 1)
            b = rng.randint(a + 1, min(hi, a + 15))
            ta = rand_value(rng, a, a, names)[0]
            tb = rand_value(rng, b, b, names)[0]
            step = f"/{rng.randint(2, 6)}" if rng.random() < 0.4 else ""
            items.append(f"{ta}-{tb}{step}")
    return ",".join(items)


def rand_cron(rng):
    minute = rand_cron_field(rng, 0, 59, None)
    hour = rand_cron_field(rng, 0, 23, None, dense=True)
    dom = rand_cron_field(rng, 1, 31, None, dense=True) if rng.random() < 0.6 else "*"
    month = rand_cron_field(rng, 1, 12, MONTHS, dense=True) if rng.random() < 0.4 else "*"
    dow = rand_cron_field(rng, 0, 7, DAYS, dense=True) if rng.random() < 0.6 else "*"
    return f"{minute} {hour} {dom} {month} {dow}"


def croniter_safe_cron(expr):
    """croniter reads '*/n' day fields with OR where Vixie uses AND; it also has no Vixie flags."""
    parts = CRON_NICK.get(expr.strip().lower(), expr).split()
    dom, dow = parts[2], parts[4]
    restricted = lambda f: f != "*"
    starred = lambda f: f.startswith("*") and f != "*"
    if (starred(dom) and restricted(dow)) or (starred(dow) and restricted(dom)):
        return False, "a day field starts with * but is restricted while the other is restricted: Vixie AND, croniter OR"
    return True, None


def rand_q_time(rng, lo, hi, zero_chance):
    r = rng.random()
    if r < zero_chance:
        return str(lo if rng.random() < 0.7 else rng.randint(lo, hi))
    if r < zero_chance + 0.12:
        return "*"
    if r < zero_chance + 0.30:
        return f"*/{rng.randint(2, min(30, hi))}"
    if r < zero_chance + 0.45:
        a = rng.randint(lo, hi - 1)
        return f"{a}/{rng.randint(2, max(2, min(30, hi - a)))}"
    if r < zero_chance + 0.65:
        a = rng.randint(lo, hi - 1)
        b = rng.randint(a + 1, min(hi, a + 12))
        return f"{a}-{b}" + (f"/{rng.randint(2, 5)}" if rng.random() < 0.4 else "")
    return ",".join(sorted({str(rng.randint(lo, hi)) for _ in range(rng.randint(2, 4))}, key=int))


def rand_quartz(rng):
    sec = rand_q_time(rng, 0, 59, 0.6)
    minute = rand_q_time(rng, 0, 59, 0.3)
    hour = rand_q_time(rng, 0, 23, 0.25)
    # Quartz reads a name range only as NAME-NAME, and NetForge refuses steps after names.
    r = rng.random()
    if r < 0.6:
        month = "*"
    elif r < 0.75:
        a = rng.randint(1, 11)
        month = f"{MONTHS[a - 1].upper()}-{MONTHS[rng.randint(a + 1, 12) - 1].upper()}"
    elif r < 0.85:
        month = ",".join(sorted({MONTHS[rng.randint(0, 11)].upper() for _ in range(rng.randint(1, 3))}))
    else:
        month = rand_cron_field(rng, 1, 12, None)
    if rng.random() < 0.5:
        r = rng.random()
        if r < 0.15:
            dom = "L"
        elif r < 0.25:
            dom = f"L-{rng.randint(1, 27)}"
        elif r < 0.33:
            dom = "LW"
        elif r < 0.45:
            dom = f"{rng.randint(1, 28)}W"
        elif r < 0.55:
            dom = "*"
        else:
            dom = rand_cron_field(rng, 1, 31, None)
        dow = "?"
    else:
        dom = "?"
        r = rng.random()
        if r < 0.15:
            dow = f"{rng.choice([str(rng.randint(1, 7)), DAYS[rng.randint(0, 6)].upper()])}L"
        elif r < 0.32:
            dow = f"{rng.choice([str(rng.randint(1, 7)), DAYS[rng.randint(0, 6)].upper()])}#{rng.randint(1, 5)}"
        elif r < 0.37:
            dow = "L"
        elif r < 0.45:
            dow = "*"
        else:
            k = rng.randint(1, 2)
            items = []
            for _ in range(k):
                if rng.random() < 0.5:
                    a = rng.randint(1, 6)
                    b = rng.randint(a + 1, 7)
                    if rng.random() < 0.5:
                        items.append(f"{DAYS[a - 1].upper()}-{DAYS[b - 1].upper()}")
                    else:
                        items.append(f"{a}-{b}" + (f"/{rng.randint(2, 3)}" if rng.random() < 0.3 else ""))
                else:
                    items.append(rng.choice([str(rng.randint(1, 7)), DAYS[rng.randint(0, 6)].upper()]))
            dow = ",".join(items)
    year = ""
    if rng.random() < 0.25:
        a = rng.randint(2026, 2060)
        year = " " + rng.choice([str(a), f"{a}-{a + rng.randint(1, 20)}", f"{a}/{rng.randint(2, 7)}", "*"])
    return f"{sec} {minute} {hour} {dom} {month} {dow}{year}"


def croniter_quartz(expr):
    """The same schedule in croniter syntax (seconds first, weekdays 0-6), or None with a reason."""
    parts = expr.split()
    if len(parts) == 7:
        return None, "year field"
    sec, minute, hour, dom, month, dow = parts
    if dom.upper() not in ("?", "L") and any(ch in dom.upper() for ch in "LW"):
        return None, "L-n, LW or nW in day of month"
    cdom = "*" if dom == "?" else dom
    if dow == "?":
        cdow = "*"
    elif dow.upper() == "L":
        cdow = "6"
    elif dow.upper().endswith("L"):
        cdow = f"L{q_num(dow[:-1], DAYS) - 1}"
    elif "#" in dow:
        a, k = dow.split("#")
        cdow = f"{q_num(a, DAYS) - 1}#{k}"
    else:
        items = []
        for item in dow.split(","):
            base, _, step = item.partition("/")
            if base == "*":
                items.append(item)
                continue
            if "-" in base:
                x, y = base.split("-")
                if x.isdigit():
                    base = f"{int(x) - 1}-{int(y) - 1}"
            elif base.isdigit():
                base = str(int(base) - 1)
            items.append(base + (f"/{step}" if step else ""))
        cdow = ",".join(items)
    return f"{sec} {minute} {hour} {cdom} {month} {cdow}", None


# ---- DST rows as NetForge models them --------------------------------------------------------

def wall_ms(dt):
    return epoch_s(dt) * 1000


def resolve(wall, zone):
    hits = set()
    for fold in (0, 1):
        aware = wall.replace(tzinfo=zone, fold=fold)
        ts = int(aware.timestamp())
        if datetime.fromtimestamp(ts, zone).replace(tzinfo=None) == wall:
            hits.add(ts)
    return sorted(hits)


def offset(ts, zone):
    return int(datetime.fromtimestamp(ts, zone).utcoffset().total_seconds())


def gap_transition(wall, zone):
    t0 = int(wall.replace(tzinfo=zone, fold=0).timestamp())
    t1 = int(wall.replace(tzinfo=zone, fold=1).timestamp())
    lo, hi = min(t0, t1), max(t0, t1)
    before = offset(lo, zone)
    while hi - lo > 1:
        mid = (lo + hi) // 2
        if offset(mid, zone) == before:
            lo = mid
        else:
            hi = mid
    return hi


def walls_after(dialect, expr, start_wall):
    day_ok, times, year_ok, last_year = parse(dialect, expr)
    d = start_wall.date()
    while d.year <= last_year:
        if year_ok(d.year) and day_ok(d.year, d.month, d.day):
            base = datetime(d.year, d.month, d.day)
            for t in times:
                w = base + timedelta(seconds=t)
                if w >= start_wall:
                    yield w
        d += timedelta(days=1)


def dst_rows(dialect, expr, zone_name, from_s, count):
    zone = ZoneInfo(zone_name)
    from_ms = from_s * 1000
    start_wall = (EPOCH + timedelta(seconds=from_s)) - timedelta(hours=30)
    pending = []
    runs = 0
    horizon = None
    for w in walls_after(dialect, expr, start_wall):
        wm = wall_ms(w)
        if horizon is not None and wm > horizon:
            break
        inst = resolve(w, zone)
        if not inst:
            at = gap_transition(w, zone) * 1000
            if at > from_ms:
                pending.append((at, 0, {"type": "group", "kind": "nonexistent", "at": at, "firstWallMs": wm, "lastWallMs": wm, "count": 1}))
        elif len(inst) == 1:
            if inst[0] * 1000 > from_ms:
                pending.append((inst[0] * 1000, 1, {"type": "run", "kind": "normal", "epochMs": inst[0] * 1000, "wallMs": wm}))
                runs += 1
        else:
            for kind, ts in (("repeated-first", inst[0]), ("repeated-second", inst[1])):
                if ts * 1000 > from_ms:
                    pending.append((ts * 1000, 1, {"type": "run", "kind": kind, "epochMs": ts * 1000, "wallMs": wm}))
                    runs += 1
        if horizon is None and runs >= count + 4:
            horizon = wm + 40 * 3600 * 1000
    pending.sort(key=lambda p: (p[0], p[1]))
    rows = []
    found = 0
    for _, _, row in pending:
        if found >= count:
            break
        if row["type"] == "run":
            found += 1
            rows.append(dict(row))
            continue
        prev = rows[-1] if rows else None
        if prev and prev["type"] == "group" and prev["at"] == row["at"]:
            prev["lastWallMs"] = row["lastWallMs"]
            prev["count"] += 1
        else:
            rows.append(dict(row))
    return rows


def transitions(zone_name, start, end):
    zone = ZoneInfo(zone_name)
    out = []
    t = int(start.replace(tzinfo=timezone.utc).timestamp())
    stop = int(end.replace(tzinfo=timezone.utc).timestamp())
    prev = offset(t, zone)
    while t < stop:
        nxt = t + 3600
        cur = offset(nxt, zone)
        if cur != prev:
            lo, hi = t, nxt
            while hi - lo > 1:
                mid = (lo + hi) // 2
                if offset(mid, zone) == prev:
                    lo = mid
                else:
                    hi = mid
            out.append((hi, prev, cur))
            prev = cur
        t = nxt
    return out


def main():
    rng = random.Random(20261114)
    excluded = []

    cron_cases = []
    hand_cron = ["*/15 * * * *", "0 9 * * 1-5", "0 0 1-7 * 1", "0 0 */2 * 1", "0 0 1 * */2", "30 2 1,15 * *", "@weekly", "@hourly", "@yearly",
                 "@monthly", "@daily", "@midnight", "@annually", "*/7 9-17 * * mon-fri", "0 12 * jan,jul sun", "0 0 * * 7", "0 0 * * 0-7", "5 4 * * sun",
                 "0 0 13 * 5", "0 0 31 * *", "0 0 29 2 *", "0 0 29 2 1", "59 23 31 12 *", "0 0 1 1 *", "0 22 * * 1-5", "23 0-20/2 * * *",
                 "0 0,12 1 */2 *", "0 4 8-14 * *", "0 0 * * mon-fri/2", "15 14 1 * *", "0 0 * * 6-7", "*/5 * * * *", "0 * * * *",
                 "0 0 */10 * *", "1-59/2 * * * *", "0 0 1,15 * 1", "0 0 15 * MON", "0 9 * JAN-MAR,OCT-DEC *", "0 0 L1", "0 0 * * Sat"]
    hand_cron = [e for e in hand_cron if e != "0 0 L1"]
    seen = set()
    candidates = [(e, True) for e in hand_cron]
    while len(candidates) < 340:
        e = rand_cron(rng)
        if e not in seen:
            seen.add(e)
            candidates.append((e, False))
    for expr, hand in candidates:
        start = rng.randint(epoch_s(datetime(2025, 1, 1)), epoch_s(datetime(2027, 12, 31)))
        runs, limit, last_year = brute_runs("cron", expr, start, RUNS)
        stop = expected_stop("cron", expr, start, len(runs), RUNS, limit, last_year)
        refs = ["bruteforce"]
        safe, reason = croniter_safe_cron(expr)
        if safe and len(runs) == RUNS:
            c = croniter_runs(expr, start, RUNS)
            if c == runs:
                refs.append("croniter")
            else:
                excluded.append({"dialect": "cron", "expr": expr, "reason": f"croniter disagrees: {c[:3] if isinstance(c, list) else c} vs {runs[:3]}"})
        elif not safe:
            excluded.append({"dialect": "cron", "expr": expr, "reason": reason})
        cron_cases.append({"expr": expr, "from": start, "runs": runs, "stop": stop, "refs": refs})

    quartz_cases = []
    hand_quartz = ["0 0/15 * * * ?", "0 15 10 ? * 6L", "0 0 12 15W * ?", "0 0 12 1W * ?", "0 0 12 LW * ?", "0 0 12 L-3 * ?", "0 0 12 L * ?",
                   "0 0 9 ? * MON-FRI", "0 0 9 ? * 2#1", "0 0 9 ? * 2#5", "0 15 10 ? * 6#3", "0 0 0 29 2 ? 2028-2040", "0 0 12 ? * L",
                   "0 15 10 * * ? 2026", "0 0/5 14,18 * * ?", "0 0-5 14 * * ?", "0 10,44 14 ? 3 WED", "0 15 10 L * ?", "0 15 10 ? * 6L 2026-2030",
                   "*/30 * * * * ?", "5/20 * * * * ?", "0 0 0 1 JAN ?", "0 0 0 ? * SUN#2", "0 0 0 ? * FRIL", "0 0 0 28W 2 ?", "0 30 23 L-27 * ?",
                   "59 59 23 31 DEC ?", "0 0 0 ? 2 2#5 2000-2099", "0 0 0 29 2 ?", "0 0 12 ? * 1,7", "0 0 6 ? * SUN-SAT/2"]
    hand_quartz = [e for e in hand_quartz if e != "0 0 6 ? * SUN-SAT/2"]
    seen = set()
    candidates = [(e, True) for e in hand_quartz]
    while len(candidates) < 200:
        e = rand_quartz(rng)
        if e not in seen:
            seen.add(e)
            candidates.append((e, False))
    for expr, hand in candidates:
        start = rng.randint(epoch_s(datetime(2025, 1, 1)), epoch_s(datetime(2027, 12, 31)))
        runs, limit, last_year = brute_runs("quartz", expr, start, RUNS)
        stop = expected_stop("quartz", expr, start, len(runs), RUNS, limit, last_year)
        refs = ["bruteforce"]
        mapped, reason = croniter_quartz(expr)
        if mapped and len(runs) == RUNS:
            c = croniter_runs(mapped, start, RUNS, seconds=True)
            if c == runs:
                refs.append("croniter")
            else:
                excluded.append({"dialect": "quartz", "expr": expr, "reason": f"croniter ({mapped}) disagrees: {c[:3] if isinstance(c, list) else c} vs {runs[:3]}"})
        elif reason:
            excluded.append({"dialect": "quartz", "expr": expr, "reason": f"croniter has no {reason}"})
        quartz_cases.append({"expr": expr, "from": start, "runs": runs, "stop": stop, "refs": refs})

    # DST: every transition in the window, several expressions and start times around it.
    dst_cases = []
    windows = [
        ("America/New_York", datetime(2026, 1, 1), datetime(2027, 1, 1)),
        ("Europe/London", datetime(2026, 1, 1), datetime(2027, 1, 1)),
        ("Australia/Lord_Howe", datetime(2026, 1, 1), datetime(2027, 1, 1)),
        ("Pacific/Chatham", datetime(2026, 1, 1), datetime(2027, 1, 1)),
        ("America/Sao_Paulo", datetime(2018, 6, 1), datetime(2019, 6, 1)),
        ("Pacific/Apia", datetime(2011, 1, 1), datetime(2012, 1, 1)),
    ]
    for zone_name, start, end in windows:
        zone = ZoneInfo(zone_name)
        for at, before, after in transitions(zone_name, start, end):
            local_lo = EPOCH + timedelta(seconds=at + min(before, after))
            h = local_lo.hour
            exprs = [
                ("cron", "*/15 * * * *"), ("cron", "0 * * * *"), ("cron", f"30 {h} * * *"), ("cron", f"* {h} * * *"),
                ("cron", f"0,20,40 {h},{(h + 1) % 24} * * *"), ("cron", f"{local_lo.minute} {h} * * *"),
                ("quartz", "0 0/30 * * * ?"), ("quartz", f"30 15 {h} * * ?"), ("quartz", f"0 */10 {h} ? * *"),
            ]
            if zone_name == "Pacific/Apia" and abs(after - before) >= 86400 - 3600:
                exprs += [("cron", "0 12 * * *"), ("cron", "0 0 30 12 *"), ("quartz", "0 0 9 L * ?")]
            froms = [at - 3 * 3600, at - 40 * 60, at + 60, at + 20 * 60]
            for dialect, expr in exprs:
                for f in froms:
                    dst_cases.append({"dialect": dialect, "expr": expr, "zone": zone_name, "from": f * 1000, "count": DST_COUNT,
                                      "rows": dst_rows(dialect, expr, zone_name, f, DST_COUNT)})
    for zone_name, f in (("Asia/Kolkata", epoch_s(datetime(2026, 3, 7, 20))), ("UTC", epoch_s(datetime(2026, 10, 31, 23))), ("Asia/Kolkata", epoch_s(datetime(2026, 11, 1)))):
        for dialect, expr in (("cron", "*/15 * * * *"), ("cron", "30 2 * * *"), ("quartz", "0 0/30 1-3 * * ?")):
            dst_cases.append({"dialect": dialect, "expr": expr, "zone": zone_name, "from": f * 1000, "count": DST_COUNT, "rows": dst_rows(dialect, expr, zone_name, f, DST_COUNT)})

    # Leap days, month ends, year boundaries, rare and impossible schedules.
    special = []
    special_list = [
        ("cron", "0 0 29 2 *", datetime(2026, 11, 14)), ("cron", "0 0 29 2 *", datetime(2096, 3, 1)),
        ("cron", "0 0 29 2 1", datetime(2026, 11, 14)), ("cron", "0 0 */29 2 */8", datetime(2026, 1, 1)),
        ("cron", "0 0 31 * *", datetime(2026, 1, 31, 12)), ("cron", "59 23 31 12 *", datetime(2026, 12, 31, 23, 58, 30)),
        ("cron", "* * * * *", datetime(2026, 12, 31, 23, 58, 30)), ("cron", "0 0 1 1 *", datetime(2099, 6, 1)),
        ("cron", "0 0 30 2 *", datetime(2026, 1, 1)), ("cron", "0 0 31 4,6,9,11 *", datetime(2026, 1, 1)),
        ("cron", "0 0 30,31 2 *", datetime(2026, 1, 1)), ("cron", "0 12 28-31 2 *", datetime(2027, 2, 27)),
        ("quartz", "0 0 0 29 2 ?", datetime(2026, 11, 14)), ("quartz", "0 0 0 ? 2 2#5 2000-2099", datetime(2026, 1, 1)),
        ("quartz", "0 0 0 30 2 ?", datetime(2026, 1, 1)), ("quartz", "0 0 0 1 1 ? 2099", datetime(2026, 1, 1)),
        ("quartz", "0 0 0 1 1 ? 2020-2025", datetime(2026, 1, 1)), ("quartz", "0 0 12 L-27 2 ?", datetime(2026, 1, 1)),
        ("quartz", "0 0 12 LW * ?", datetime(2026, 1, 30)), ("quartz", "59 59 23 L 12 ?", datetime(2026, 12, 31, 23, 59, 58)),
        ("quartz", "0 0 0 ? * 1#5 2026", datetime(2026, 1, 1)), ("quartz", "* * * 31 12 ? 2098-2099", datetime(2099, 12, 31, 23, 59, 50)),
        ("quartz", "0 0 0 ? 2 2#5", datetime(2026, 1, 1)), ("quartz", "0 0 0 1W 5 ?", datetime(2026, 1, 1)),
    ]
    for dialect, expr, start_dt in special_list:
        start = epoch_s(start_dt)
        runs, limit, last_year = brute_runs(dialect, expr, start, DST_COUNT)
        special.append({"dialect": dialect, "expr": expr, "zone": "UTC", "from": start, "count": DST_COUNT, "runs": runs,
                        "stop": expected_stop(dialect, expr, start, len(runs), DST_COUNT, limit, last_year)})

    data = {
        "source": "python brute force from the Vixie cron and Quartz rules; croniter where faithful; zoneinfo for DST",
        "tzdata": tzdata.IANA_VERSION, "croniter": croniter_module.__version__ if hasattr(croniter_module, "__version__") else "6.0.0",
        "runsPerCase": RUNS, "cron": cron_cases, "quartz": quartz_cases, "dst": dst_cases, "special": special, "croniterExcluded": excluded,
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_bytes((json.dumps(data, separators=(",", ":")) + "\n").encode("ascii"))
    gaps = sum(1 for c in dst_cases if any(r["type"] == "group" for r in c["rows"]))
    reps = sum(1 for c in dst_cases if any(r["kind"] == "repeated-second" for r in c["rows"]))
    both = sum(1 for c in cron_cases if "croniter" in c["refs"])
    qboth = sum(1 for c in quartz_cases if "croniter" in c["refs"])
    print(f"tzdata {tzdata.IANA_VERSION}: cron {len(cron_cases)} ({both} also croniter), quartz {len(quartz_cases)} ({qboth} also croniter), "
          f"dst {len(dst_cases)} ({gaps} with gaps, {reps} with repeats), special {len(special)}, croniter exclusions {len(excluded)} -> {OUT}")
    for e in excluded:
        if "disagrees" in e["reason"]:
            print("DISAGREE", e)


if __name__ == "__main__":
    main()
