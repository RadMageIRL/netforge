"""Expected network-plan results from Python's ipaddress module and brute force, independent of
NetForge's code. Writes tests/fixtures/plan-oracle.json. Deterministic: same output on every run.

    python scripts/oracles/plan_oracle.py

Sections:
  scoping    overlaps between VLAN networks: which pairs are conflicts (same VRF, or VRFs that
             exchange routes) and which are reuse across independent VRFs
  vlanids    duplicate VLAN IDs, per VLAN namespace
  addressing gateway, DHCP pool, reservation and host-capacity findings for single VLANs
  prefix6    IPv6 prefix allocation by trying every child prefix in address order
  alloc4     IPv4 allocation into several parent networks by trying every aligned subnet
"""
import ipaddress as ip
import json
import random
from pathlib import Path

OUT = Path(__file__).resolve().parents[2] / "tests" / "fixtures" / "plan-oracle.json"
rng = random.Random(20261114)


def v4(text):
    return ip.IPv4Network(text, strict=False)


# ---- scoping --------------------------------------------------------------------------------------
def scoping_case():
    nvrf = rng.randint(2, 4)
    vrfs = [f"r{i + 1}" for i in range(nvrf)]
    exchanges = {v: [] for v in vrfs}
    for a in vrfs:
        for b in vrfs:
            if a != b and rng.random() < 0.25:
                exchanges[a].append(b)
    linked = set()
    for a, lst in exchanges.items():
        for b in lst:
            linked.add((a, b))
            linked.add((b, a))
    vlans = []
    for i in range(rng.randint(15, 30)):
        net4 = None
        net6 = None
        if rng.random() < 0.8:
            length = rng.randint(20, 28)
            net4 = ip.IPv4Network((0x0A000000 | rng.randrange(1 << 16), length), strict=False)
        if rng.random() < 0.5:
            length = rng.randint(56, 64)
            base = int(ip.IPv6Address("2001:db8::"))
            net6 = ip.IPv6Network((base | (rng.randrange(1 << 16) << 64), length), strict=False)
        vlans.append({"id": f"v{i + 1}", "vrf": rng.choice(vrfs), "ipv4": str(net4) if net4 else "", "ipv6": str(net6) if net6 else ""})
    conflicts = set()
    kinds = {}
    identical = set()
    reuse = set()
    for a in vlans:
        for b in vlans:
            if a is b:
                continue
            for fam in ("ipv4", "ipv6"):
                if not a[fam] or not b[fam]:
                    continue
                na = ip.ip_network(a[fam])
                nb = ip.ip_network(b[fam])
                if not na.overlaps(nb):
                    continue
                if a["vrf"] == b["vrf"] or (a["vrf"], b["vrf"]) in linked:
                    conflicts.add(f"{a['id']}>{b['id']}")
                    kinds[f"{a['id']}>{b['id']}>{fam}"] = "same-vrf" if a["vrf"] == b["vrf"] else "exchanging-vrfs"
                    if na == nb:
                        identical.add(f"{a['id']}>{b['id']}>{fam}")
                else:
                    reuse.add(f"{a['id']}|{4 if fam == 'ipv4' else 6}|{b['vrf']}")
    return {
        "vrfs": [{"id": v, "exchangesWith": exchanges[v]} for v in vrfs],
        "vlans": vlans,
        "conflicts": sorted(conflicts),
        "kinds": kinds,
        "identical": sorted(identical),
        "reuse": sorted(reuse),
    }


# ---- VLAN IDs -------------------------------------------------------------------------------------
def vlanid_case():
    sites = [f"s{i + 1}" for i in range(rng.randint(1, 3))]
    namespaces = [{"id": f"n{i + 1}", "siteId": rng.choice(sites + [""])} for i in range(rng.randint(1, 4))]
    vlans = []
    for i in range(rng.randint(10, 40)):
        vid = rng.choice([str(rng.randint(1, 12))] * 8 + ["0", "4095", "x", "", "4094", " 7 "])
        vlans.append({"id": f"v{i + 1}", "siteId": rng.choice(sites), "namespaceId": rng.choice(namespaces)["id"], "vlanId": vid})
    groups = {}
    for v in vlans:
        t = v["vlanId"].strip()
        if not t.isdigit() or not (1 <= int(t) <= 4094):
            continue
        groups.setdefault((v["namespaceId"], int(t)), []).append(v["id"])
    dups = {}
    for members in groups.values():
        if len(members) > 1:
            for m in members:
                dups[m] = sorted(x for x in members if x != m)
    return {"sites": sites, "namespaces": namespaces, "vlans": vlans, "duplicates": dups}


# ---- addressing -----------------------------------------------------------------------------------
def addr_text(value):
    return str(ip.IPv4Address(value))


def pick_near(net):
    first = int(net.network_address)
    last = int(net.broadcast_address)
    size = last - first + 1
    choice = rng.random()
    if choice < 0.15:
        return first
    if choice < 0.3:
        return last
    if choice < 0.75:
        return rng.randint(first, last)
    if choice < 0.85:
        return last + 1
    return max(0, first - rng.randint(1, size))


def range_near(net):
    a = pick_near(net)
    b = pick_near(net)
    if rng.random() < 0.06:
        lo, hi = max(a, b), min(a, b)
        if lo == hi:
            hi = lo - 1
        return lo, hi
    lo, hi = min(a, b), max(a, b)
    if rng.random() < 0.3:
        hi = min(hi, lo + rng.randint(0, 20))
    return lo, hi


def range_text(lo, hi):
    if lo == hi and rng.random() < 0.5:
        return addr_text(lo)
    return f"{addr_text(lo)} - {addr_text(hi)}"


def addressing_case():
    length = rng.choice([20, 22, 24, 24, 25, 26, 27, 28, 29, 30, 30, 31, 32])
    net = ip.IPv4Network((0x0A000000 | rng.randrange(1 << 24), length), strict=False)
    has_net = rng.random() > 0.1
    gateway = addr_text(pick_near(net)) if rng.random() < 0.8 else ""
    reserved = [range_near(net) for _ in range(rng.randint(0, 2))]
    dhcp = [range_near(net) for _ in range(rng.randint(0, 3))]
    capacity = 1 if length == 32 else 2 if length == 31 else net.num_addresses - 2
    hosts = "" if rng.random() < 0.5 else str(rng.randint(1, capacity * 2))
    first = int(net.network_address)
    last = int(net.broadcast_address)
    standard = length <= 30
    codes = []
    if not has_net:
        first = last = None
    if has_net and length == 31:
        codes.append("ipv4-point-to-point")
    if has_net and length == 32:
        codes.append("ipv4-single-address")
    if hosts:
        if has_net:
            if capacity < int(hosts):
                codes.append("capacity")
        else:
            codes.append("unallocated")
    gw = int(ip.IPv4Address(gateway)) if gateway else None
    if gw is not None:
        if not has_net:
            codes.append("gateway-no-network")
        elif gw < first or gw > last:
            codes.append("gateway-outside")
        elif standard and gw == first:
            codes.append("gateway-network")
        elif standard and gw == last:
            codes.append("gateway-broadcast")
    accepted_res = []
    for i, (lo, hi) in enumerate(reserved):
        if hi < lo:
            codes.append(f"reserved-invalid:{i}")
        elif not has_net:
            codes.append(f"reserved-no-network:{i}")
        elif lo < first or hi > last:
            codes.append(f"reserved-outside:{i}")
        else:
            if any(lo <= b and a <= hi for a, b in accepted_res):
                codes.append(f"reserved-overlap:{i}")
            accepted_res.append((lo, hi))
    accepted_pools = []
    for i, (lo, hi) in enumerate(dhcp):
        if hi < lo:
            codes.append(f"dhcp-invalid:{i}")
        elif not has_net:
            codes.append(f"dhcp-no-network:{i}")
        elif lo < first or hi > last:
            codes.append(f"dhcp-outside:{i}")
        elif standard and lo == first:
            codes.append(f"dhcp-network:{i}")
        elif standard and hi == last:
            codes.append(f"dhcp-broadcast:{i}")
        else:
            if gw is not None and lo <= gw <= hi:
                codes.append(f"dhcp-gateway:{i}")
            for a, b in accepted_res:
                if lo <= b and a <= hi:
                    codes.append(f"dhcp-reserved:{i}")
            if any(lo <= b and a <= hi for a, b in accepted_pools):
                codes.append(f"dhcp-overlap:{i}")
            accepted_pools.append((lo, hi))
    if not has_net and not hosts and not gateway and not dhcp and not reserved:
        codes.append("no-network")
    return {
        "network": str(net) if has_net else "",
        "gateway": gateway,
        "hosts": hosts,
        "dhcp": [range_text(lo, hi) if lo <= hi else f"{addr_text(lo)} - {addr_text(hi)}" for lo, hi in dhcp],
        "reserved": [range_text(lo, hi) if lo <= hi else f"{addr_text(lo)} - {addr_text(hi)}" for lo, hi in reserved],
        "codes": sorted(codes),
    }


# ---- IPv6 prefix allocation -----------------------------------------------------------------------
def prefix6_case():
    base = int(ip.IPv6Address("2001:db8::"))
    length = rng.randint(44, 56)
    child = length + rng.randint(1, 8)
    parents = []
    wanted = rng.randint(1, 2)
    while len(parents) < wanted:
        p = ip.IPv6Network((base | (rng.randrange(1 << 12) << (128 - length)) & ((1 << 128) - 1), length), strict=False)
        if all(not p.overlaps(q) for q in parents):
            parents.append(p)
    occupied = []
    for _ in range(rng.randint(0, 6)):
        anchor = rng.choice(parents)
        olen = rng.randint(max(length - 2, 0), min(child + 4, 128))
        offset = rng.randrange(anchor.num_addresses)
        occupied.append(ip.IPv6Network((int(anchor.network_address) + offset, olen), strict=False))
    requests = [{"key": f"k{i}", "count": rng.randint(1, 6)} for i in range(rng.randint(1, 8))]
    free = [c for p in parents for c in p.subnets(new_prefix=child) if not any(c.overlaps(o) for o in occupied)]
    cursor = 0
    placed = {}
    failures = []
    for r in requests:
        available = len(free) - cursor
        if r["count"] > available:
            failures.append({"key": r["key"], "available": available})
            continue
        placed[r["key"]] = [str(c) for c in free[cursor:cursor + r["count"]]]
        cursor += r["count"]
    return {
        "parents": [str(p) for p in parents],
        "child": child,
        "occupied": [str(o) for o in occupied],
        "requests": requests,
        "placed": placed,
        "failures": failures,
        "freeBefore": len(free),
        "freeAfter": len(free) - cursor,
    }


# ---- IPv4 allocation into several parents ---------------------------------------------------------
def prefix_for_hosts(hosts):
    length = 30
    while (1 << (32 - length)) - 2 < hosts:
        length -= 1
    return length


def alloc4_case():
    parents = []
    wanted = rng.randint(1, 3)
    while len(parents) < wanted:
        p = ip.IPv4Network((0x0A000000 | rng.randrange(1 << 16), rng.randint(22, 26)), strict=False)
        if all(not p.overlaps(q) for q in parents):
            parents.append(p)
    existing = []
    for _ in range(rng.randint(0, 5)):
        anchor = rng.choice(parents)
        e = ip.IPv4Network((int(anchor.network_address) + rng.randrange(anchor.num_addresses), rng.randint(24, 29)), strict=False)
        if all(not e.overlaps(x) for x in existing):
            existing.append(e)
    requests = [{"index": i, "hosts": rng.choice([rng.randint(1, 30), rng.randint(1, 120), rng.randint(1, 600)])} for i in range(rng.randint(1, 8))]
    for r in requests:
        r["length"] = prefix_for_hosts(r["hosts"])
    occupied = list(existing)
    assigned = {}
    remaining = list(requests)
    for parent in parents:
        order = sorted(remaining, key=lambda r: (r["length"], -r["hosts"], r["index"]))
        failed = set()
        for r in order:
            if r["length"] < parent.prefixlen:
                failed.add(r["index"])
                continue
            spot = next((s for s in parent.subnets(new_prefix=r["length"]) if not any(s.overlaps(o) for o in occupied)), None)
            if spot is None:
                failed.add(r["index"])
            else:
                assigned[r["index"]] = str(spot)
                occupied.append(spot)
        remaining = [r for r in remaining if r["index"] in failed]
    return {
        "parents": [str(p) for p in parents],
        "existing": [str(e) for e in existing],
        "requests": [{"index": r["index"], "hosts": r["hosts"]} for r in requests],
        "assigned": {str(k): v for k, v in assigned.items()},
        "failed": sorted(r["index"] for r in remaining),
    }


data = {
    "scoping": [scoping_case() for _ in range(120)],
    "vlanids": [vlanid_case() for _ in range(100)],
    "addressing": [addressing_case() for _ in range(800)],
    "prefix6": [prefix6_case() for _ in range(250)],
    "alloc4": [alloc4_case() for _ in range(250)],
}
# Bytes, so the file has LF line endings on every system.
OUT.write_bytes((json.dumps(data, separators=(",", ":")) + "\n").encode("utf-8"))
print(f"wrote {OUT} ({OUT.stat().st_size} bytes): " + ", ".join(f"{k} {len(v)}" for k, v in data.items()))
