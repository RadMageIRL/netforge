"""Expected IPv4 subnet values from Python's ipaddress module, an implementation independent of
NetForge's. Writes tests/fixtures/ipv4-oracle.json. Deterministic: run it twice, get the same file.

    python scripts/oracles/ipv4_oracle.py
"""
import ipaddress
import json
import random
from pathlib import Path

OUT = Path(__file__).resolve().parents[2] / "tests" / "fixtures" / "ipv4-oracle.json"
rng = random.Random(20261114)


def subnet_case(address: int, prefix: int, notation: str) -> dict:
    iface = ipaddress.IPv4Interface((address, prefix))
    net = iface.network
    if net.num_addresses <= 65536:
        hosts = list(net.hosts())
        first, last = hosts[0], hosts[-1]
    else:
        # Indexing is Python's own arithmetic: net[1] and net[-2] are the first and last hosts.
        first, last = net[1], net[-2]
    text = f"{iface.ip}/{prefix}" if notation == "prefix" else f"{iface.ip}/{net.netmask}"
    return {
        "input": text,
        "address": str(iface.ip),
        "prefix": prefix,
        "network": str(net.network_address),
        # Python reports the last address for /31 and /32 too; NetForge shows none for those.
        "lastAddress": str(net.broadcast_address),
        "netmask": str(net.netmask),
        "hostmask": str(net.hostmask),
        "numAddresses": str(net.num_addresses),
        "firstHost": str(first),
        "lastHost": str(last),
        "hostCount": str(net.num_addresses - 2 if prefix <= 30 else net.num_addresses),
    }


cases = []
for prefix in range(33):
    addresses = [0, 0xFFFFFFFF, 0x0A000001, 0xC0A80182] + [rng.randrange(1 << 32) for _ in range(8)]
    for i, address in enumerate(addresses):
        cases.append(subnet_case(address, prefix, "mask" if i % 3 == 2 else "prefix"))

# Address strings, valid and not, with Python's verdict. Built from pieces that exercise every rule:
# range, leading zeros, empty parts, part count, signs, spaces and letters.
pieces = ["0", "1", "9", "10", "99", "100", "199", "255", "256", "300", "999", "1000",
          "00", "01", "001", "010", "0x1", "1e1", "-1", "+1", " 1", "1 ", "", "a", "1.5"]
strings = set()
for _ in range(3000):
    count = rng.choice([4, 4, 4, 4, 3, 5])
    strings.add(".".join(rng.choice(pieces) for _ in range(count)))
for _ in range(300):
    strings.add(str(ipaddress.IPv4Address(rng.randrange(1 << 32))))
validity = []
for s in sorted(strings):
    try:
        ipaddress.IPv4Address(s)
        ok = True
    except ValueError:
        ok = False
    validity.append({"text": s, "valid": ok})

OUT.parent.mkdir(parents=True, exist_ok=True)
OUT.write_text(json.dumps({"source": "python ipaddress", "subnets": cases, "addresses": validity}, indent=1) + "\n", encoding="utf-8", newline="\n")
print(f"{len(cases)} subnet cases, {len(validity)} address strings "
      f"({sum(v['valid'] for v in validity)} valid) -> {OUT}")
