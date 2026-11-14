"""Expected network-engine results from Python's ipaddress module (independent of NetForge's code).
Writes tests/fixtures/net-oracle.json. Deterministic: same output on every run.

    python scripts/oracles/net_oracle.py

The VLSM section uses a brute-force reference: for each request, in the documented order, it
tries every aligned candidate subnet from ipaddress.subnets() in address order and takes the
first that overlaps nothing already placed. NetForge's allocator skips ahead instead; both must
reach the same plan.
"""
import ipaddress as ip
import json
import random
from pathlib import Path

OUT = Path(__file__).resolve().parents[2] / "tests" / "fixtures" / "net-oracle.json"
rng = random.Random(20261115)
MAX = {4: (1 << 32) - 1, 6: (1 << 128) - 1}
BITS = {4: 32, 6: 128}


def addr(family, value):
    return ip.IPv4Address(value) if family == 4 else ip.IPv6Address(value)


def net(family, value, length):
    return ip.ip_network((addr(family, value), length), strict=False)


def biased_v6():
    groups = []
    for _ in range(8):
        r = rng.random()
        groups.append(0 if r < 0.45 else rng.choice([1, 0xffff, rng.randrange(1, 16), rng.randrange(0x10000)]))
    value = 0
    for g in groups:
        value = (value << 16) | g
    return value


def random_value(family):
    if family == 6 and rng.random() < 0.6:
        return biased_v6()
    return rng.randrange(MAX[family] + 1)


def random_prefix(family):
    length = rng.randrange(BITS[family] + 1)
    return net(family, random_value(family), length)


# 1. IPv6 text forms
canonical = []
special = [0, 1, 0xFFFF << 32 | 0xC0000201, 0xFFFF << 32, (0x20010db8 << 96) | 1, (1 << 112) | (1 << 64) | 1]
for value in special + [biased_v6() for _ in range(1200)]:
    a = ip.IPv6Address(value)
    groups = [(value >> (112 - 16 * i)) & 0xFFFF for i in range(8)]
    variants = {a.exploded, a.exploded.upper(), ":".join(f"{g:x}" for g in groups), ":".join(f"{g:04X}" for g in groups), a.compressed}
    canonical.append({"value": f"{value:032x}", "compressed": a.compressed, "exploded": a.exploded, "inputs": sorted(variants)})

# 2. IPv6 validity (zone indexes are left out: Python accepts them, NetForge rejects them on purpose)
pieces = ["0", "1", "db8", "ffff", "FFFF", "0001", "12345", "g1", "", "1.2.3.4", "01.2.3.4", "256.1.1.1"]
strings = set()
for _ in range(4000):
    count = rng.choice([3, 6, 7, 8, 8, 8, 9])
    parts = [rng.choice(pieces) for _ in range(count)]
    text = ":".join(parts)
    if rng.random() < 0.4:
        cut = rng.randrange(len(text) + 1)
        text = text[:cut] + "::" + text[cut:]
    strings.add(text)
for _ in range(400):
    strings.add(ip.IPv6Address(biased_v6()).compressed)
validity = []
for s in sorted(strings):
    try:
        ip.IPv6Address(s)
        ok = True
    except ValueError:
        ok = False
    validity.append({"text": s, "valid": ok})

# 3. Prefixes: boundaries, splitting and supernets
prefixes = []
for family in (4, 6):
    for _ in range(250):
        n = random_prefix(family)
        entry = {"family": family, "network": str(n), "first": str(n.network_address), "last": str(n.broadcast_address), "size": str(n.num_addresses)}
        if n.prefixlen < BITS[family]:
            new = rng.randrange(n.prefixlen + 1, min(BITS[family], n.prefixlen + 24) + 1)
            subs = n.subnets(new_prefix=new)
            entry["split"] = {"length": new, "count": str(1 << (new - n.prefixlen)), "first": [str(next(subs)) for _ in range(min(4, 1 << (new - n.prefixlen)))]}
        if n.prefixlen > 0:
            new = rng.randrange(0, n.prefixlen)
            entry["supernet"] = {"length": new, "network": str(n.supernet(new_prefix=new))}
        prefixes.append(entry)

# 4. Range to CIDR
ranges = []
for family in (4, 6):
    for _ in range(300):
        if rng.random() < 0.5:
            a = random_value(family)
            span = rng.choice([0, 1, 2, 255, 256, 1000, 65535, rng.randrange(1, 1 << 20)])
            b = min(MAX[family], a + span)
        else:
            a, b = sorted((random_value(family), random_value(family)))
        cidrs = [str(c) for c in ip.summarize_address_range(addr(family, a), addr(family, b))]
        ranges.append({"family": family, "first": str(addr(family, a)), "last": str(addr(family, b)), "cidrs": cidrs})

# 5. Collapse (exact aggregation) of related networks: nested, adjacent, overlapping, duplicated
collapses = []
for family in (4, 6):
    for _ in range(200):
        base = random_prefix(family)
        while base.prefixlen > BITS[family] - 6:
            base = random_prefix(family)
        nets = []
        for _ in range(rng.randrange(1, 12)):
            new = rng.randrange(base.prefixlen, min(BITS[family], base.prefixlen + 6) + 1)
            subs = list(base.subnets(new_prefix=new)) if new - base.prefixlen <= 6 else [base]
            nets.append(rng.choice(subs))
        if rng.random() < 0.3:
            nets.append(nets[0])
        collapses.append({"family": family, "networks": [str(n) for n in nets], "collapsed": [str(c) for c in ip.collapse_addresses(nets)]})

# 6. Overlap and containment between pairs
pairs = []
for family in (4, 6):
    for _ in range(300):
        a = random_prefix(family)
        if rng.random() < 0.6 and a.prefixlen < BITS[family]:
            b = rng.choice(list(a.subnets(new_prefix=min(BITS[family], a.prefixlen + rng.randrange(1, 4)))))
            if rng.random() < 0.5:
                a, b = b, a
        else:
            b = random_prefix(family)
        pairs.append({"family": family, "a": str(a), "b": str(b), "overlaps": a.overlaps(b), "aInB": a.subnet_of(b), "bInA": b.subnet_of(a)})

# 7. Gaps: a parent minus some of its subnets (address_exclude)
gaps = []
for family in (4, 6):
    for _ in range(80):
        parent = random_prefix(family)
        while parent.prefixlen > BITS[family] - 8:
            parent = random_prefix(family)
        children = []
        for _ in range(rng.randrange(1, 6)):
            new = rng.randrange(parent.prefixlen + 1, parent.prefixlen + 9)
            count = 1 << (new - parent.prefixlen)
            k = rng.randrange(count)
            child = ip.ip_network((addr(family, int(parent.network_address) + k * (1 << (BITS[family] - new))), new))
            if not any(child.overlaps(c) for c in children):
                children.append(child)
        remaining = [parent]
        for c in children:
            nxt = []
            for r in remaining:
                if c.subnet_of(r):
                    nxt.extend(r.address_exclude(c))
                elif not r.overlaps(c):
                    nxt.append(r)
            remaining = nxt
        gaps.append({"family": family, "parent": str(parent), "children": [str(c) for c in children], "remaining": [str(r) for r in ip.collapse_addresses(remaining)]})

# 8. Classification flags at every registry block boundary and at random addresses
probe_blocks = {
    4: ["0.0.0.0/8", "10.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8", "169.254.0.0/16", "172.16.0.0/12", "192.0.0.0/24", "192.0.0.0/29",
        "192.0.0.8/32", "192.0.0.9/32", "192.0.0.10/32", "192.0.0.170/31", "192.0.2.0/24", "192.31.196.0/24", "192.52.193.0/24", "192.88.99.0/24",
        "192.168.0.0/16", "192.175.48.0/24", "198.18.0.0/15", "198.51.100.0/24", "203.0.113.0/24", "224.0.0.0/4", "240.0.0.0/4", "255.255.255.255/32"],
    6: ["::1/128", "::/128", "::ffff:0:0/96", "64:ff9b::/96", "64:ff9b:1::/48", "100::/64", "100:0:0:1::/64", "2001::/23", "2001::/32", "2001:1::1/128",
        "2001:1::2/128", "2001:1::3/128", "2001:2::/48", "2001:3::/32", "2001:4:112::/48", "2001:10::/28", "2001:20::/28", "2001:30::/28", "2001:db8::/32",
        "2002::/16", "2620:4f:8000::/48", "3fff::/20", "5f00::/16", "fc00::/7", "fe80::/10", "fec0::/10", "ff00::/8", "2000::/3", "4000::/3", "fe00::/9"],
}
addresses = set()
for family, blocks in probe_blocks.items():
    for b in blocks:
        n = ip.ip_network(b)
        for v in (int(n.network_address) - 1, int(n.network_address), int(n.broadcast_address), int(n.broadcast_address) + 1):
            if 0 <= v <= MAX[family]:
                addresses.add((family, v))
    for _ in range(400):
        addresses.add((family, random_value(family)))
flags = []
for family, v in sorted(addresses):
    a = addr(family, v)
    row = {"family": family, "address": str(a), "private": a.is_private, "global": a.is_global, "loopback": a.is_loopback, "linkLocal": a.is_link_local,
           "multicast": a.is_multicast, "reserved": a.is_reserved, "unspecified": a.is_unspecified}
    if family == 6:
        row["siteLocal"] = a.is_site_local
    flags.append(row)


# 9. VLSM brute-force reference
def prefix_for(hosts, p2p):
    if p2p and hosts == 1:
        return 32
    if p2p and hosts == 2:
        return 31
    for length in range(30, -1, -1):
        if (1 << (32 - length)) - 2 >= hosts:
            return length
    raise ValueError(hosts)


HOSTS = [1, 2, 3, 5, 6, 7, 14, 30, 31, 50, 62, 63, 100, 126, 127, 200, 254, 255, 400, 500, 1000, 2000]
vlsm = []
for _ in range(300):
    block16 = ip.ip_network((ip.IPv4Address(rng.randrange(1 << 32) & ~0xFFFF), 16))
    parent = rng.choice(list(block16.subnets(new_prefix=rng.choice([16, 18, 20, 22, 23, 24]))))
    p2p = rng.random() < 0.3
    fixed, reserved, taken = [], [], []
    for _ in range(rng.randrange(0, 3)):
        length = rng.randrange(parent.prefixlen + 1, 31)
        cand = rng.choice(list(parent.subnets(new_prefix=length))[:512])
        if not any(cand.overlaps(t) for t in taken):
            taken.append(cand)
            fixed.append({"name": f"fixed{len(fixed)}", "network": str(cand)})
    for _ in range(rng.randrange(0, 3)):
        start = rng.randrange(int(parent.network_address), int(parent.broadcast_address) + 1)
        end = min(int(parent.broadcast_address), start + rng.randrange(0, 40))
        span = list(ip.summarize_address_range(ip.IPv4Address(start), ip.IPv4Address(end)))
        if not any(s.overlaps(t) for s in span for t in taken):
            taken.extend(span)
            reserved.append({"name": f"res{len(reserved)}", "range": f"{ip.IPv4Address(start)} - {ip.IPv4Address(end)}"})
    requests = [{"name": f"r{i}", "hosts": rng.choice(HOSTS) if rng.random() < 0.7 else rng.randrange(1, 3000)} for i in range(rng.randrange(1, 13))]
    occupied = list(taken)
    order = sorted(range(len(requests)), key=lambda i: (prefix_for(requests[i]["hosts"], p2p), -requests[i]["hosts"], i))
    result = {}
    for i in order:
        length = prefix_for(requests[i]["hosts"], p2p)
        if length < parent.prefixlen:
            result[i] = "larger-than-parent"
            continue
        for cand in parent.subnets(new_prefix=length):
            if not any(cand.overlaps(o) for o in occupied):
                result[i] = str(cand)
                occupied.append(cand)
                break
        else:
            result[i] = "no-space"
    vlsm.append({"parent": str(parent), "pointToPoint": p2p, "fixed": fixed, "reserved": reserved, "requests": requests,
                 "order": order, "result": [result[i] for i in range(len(requests))]})

OUT.write_text(json.dumps({"source": "python ipaddress", "canonical": canonical, "validity": validity, "prefixes": prefixes, "ranges": ranges,
                           "collapses": collapses, "pairs": pairs, "gaps": gaps, "flags": flags, "vlsm": vlsm}, separators=(",", ":")) + "\n",
               encoding="utf-8", newline="\n")
print(f"{len(canonical)} canonical, {len(validity)} validity ({sum(v['valid'] for v in validity)} valid), {len(prefixes)} prefixes, "
      f"{len(ranges)} ranges, {len(collapses)} collapses, {len(pairs)} pairs, {len(gaps)} gap cases, {len(flags)} flag rows, "
      f"{len(vlsm)} VLSM scenarios ({sum(r.count('no-space') + r.count('larger-than-parent') for r in [s['result'] for s in vlsm])} failed requests) -> {OUT}")
