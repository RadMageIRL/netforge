#!/usr/bin/env python3
"""Reference results for the chmod Calculator from the real GNU coreutils chmod.

Run inside Linux (WSL Debian), never on Windows:

  MSYS_NO_PATHCONV=1 wsl.exe -d Debian -- python3 /mnt/e/code/NetForge/scripts/oracles/chmod_oracle.py \
    | tr -d '\r' > tests/fixtures/chmod-oracle.json

For every case it creates a file or directory in a private temporary directory on the Linux
filesystem, sets a starting mode with os.chmod, runs `chmod <expression> <path>` under a umask and
records the resulting mode from os.stat. chmod's exit status is recorded too: GNU chmod applies a
clause with no "who" and then exits 1 when the umask kept it from doing all that was asked.
The case list is deterministic.
"""
import json
import os
import random
import shutil
import stat
import subprocess
import sys
import tempfile

START_MODES = [0o000, 0o644, 0o755, 0o600, 0o777, 0o640, 0o711, 0o444, 0o070, 0o007, 0o4755, 0o2755, 0o1777, 0o6711, 0o7000, 0o7777, 0o2070, 0o4100, 0o1001, 0o524]
UMASKS = [0o022, 0o002, 0o077, 0o000, 0o027, 0o777]

FIXED = [
    'u+x', 'g+w', 'o-r', 'a+r', 'a-x', 'a=r', 'u=rwx,g=rx,o=rx', 'go-w', 'ug+rw', 'o=', 'u=', 'a=', '=',
    '+x', '-x', '+w', '-w', '+r', '-r', '=r', '=rw', '=rwx', '+rwx', '-rwx', '+X', '-X', '=X', '=rX',
    'u+s', 'g+s', 'o+s', 'a+s', '+s', '-s', 'u-s', 'g-s', 'ug+s', 'ug-s', '=s', 'u=s', 'g=s', 'u=rwxs', 'g=rxs',
    '+t', '-t', 'u+t', 'g+t', 'o+t', 'a+t', 'a-t', '=t', 'o=t', 'o=rwxt', 'a=rwxt', 'a=rwxst',
    'u=g', 'g=u', 'o=u', 'o=g', 'u=o', 'g=o', 'a=u', 'a=g', 'a=o', 'g+u', 'o-g', 'u-o', 'go=u', 'ug=o', '=u', '=g', '+u', '-o', '+g',
    'a+X', 'u+X', 'g+X', 'o+X', 'go+X', 'a-X', 'a=X', 'u=rwX,g=rX,o=rX', 'a=rX', 'go=rX', 'a-x+X', 'a-x,a+X', 'u-x,go+X',
    'u=rw,g+r-w', 'u+r-w+x', 'a-rwx+r', 'g=r+w', 'o+r=x', 'u-w+w', 'a=rwx-w', 'ug=rw-r', 'u+rwx-rwx', '+r-w', '=r+x', '-w+w',
    'u+', 'g-', 'a+', '+', '-', 'u+,g-,o=', 'u+x,', ',u+x', 'u', 'x', 'u+x,,g+w', 'u+q', 'z+x', 'u+x g+w', 'u+rx,g', 'u=gr', 'u=rg', 'u+xs', 'ugo+rwxXst', 'a=ugo',
    'u+x,g+s', 'g=s,u+r', 'u=rwx,go=', 'a=,u+rw', 'u=rw,go=r', 'u=rwx,g=rx,o=', 'ug=rwx,o=rx', 'a-s', 'a-st', 'u-s,g-s', 'a=rwx,o+t',
]

NUMERIC = ['755', '0755', '00755', '644', '0644', '00644', '000', '0000', '00000', '777', '0777', '2755', '02755', '4755', '6755', '1777', '01777', '001777', '7777', '0', '7', '75', '070', '2000', '4000', '6000', '0700', '000700', '1755']


def expressions():
    rng = random.Random(20261114)
    out = list(FIXED)
    whos = ['', 'u', 'g', 'o', 'a', 'ug', 'go', 'uo', 'ugo', 'ua']
    perms = ['r', 'w', 'x', 'X', 's', 't', 'rw', 'rx', 'wx', 'rwx', 'rX', 'rwX', 'xs', 'rs', 'st', 'xt', 'rwxs', 'rwxt', 'Xs', 'wX', '', 'u', 'g', 'o']
    seen = set(out)
    while len(out) < len(FIXED) + 260:
        clauses = []
        for _ in range(rng.choice([1, 1, 1, 2, 2, 3])):
            text = rng.choice(whos)
            for _ in range(rng.choice([1, 1, 1, 2])):
                text += rng.choice('+-=') + rng.choice(perms)
            clauses.append(text)
        expr = ','.join(clauses)
        if expr not in seen:
            seen.add(expr)
            out.append(expr)
    return out


def main():
    if sys.platform != 'linux':
        sys.exit('Run this inside Linux (WSL Debian).')
    version = subprocess.run(['chmod', '--version'], capture_output=True, text=True).stdout.splitlines()[0]
    root = tempfile.mkdtemp(prefix='netforge-chmod-')
    cases = []
    rng = random.Random(7)
    try:
        file_path = os.path.join(root, 'f')
        dir_path = os.path.join(root, 'd')
        open(file_path, 'w').close()
        os.mkdir(dir_path)

        def run(expr, start, directory, umask):
            path = dir_path if directory else file_path
            os.chmod(path, start)
            os.umask(umask)
            proc = subprocess.run(['chmod', '--', expr, path], capture_output=True, text=True)
            os.umask(0o022)
            after = stat.S_IMODE(os.stat(path).st_mode)
            failed = proc.returncode != 0 and ('invalid mode' in proc.stderr)
            return {'expr': expr, 'start': start, 'dir': directory, 'umask': umask, 'status': proc.returncode,
                    'invalid': failed, 'result': None if failed else after}

        for expr in expressions():
            # Every expression on a few fixed combinations, plus random ones.
            combos = [(0o644, False, 0o022), (0o755, True, 0o022), (0o6711, True, 0o027), (0o7777, False, 0o002)]
            for _ in range(6):
                combos.append((rng.choice(START_MODES), rng.random() < 0.5, rng.choice(UMASKS)))
            for start, directory, umask in combos:
                cases.append(run(expr, start, directory, umask))
        numeric = []
        for digits in NUMERIC:
            for start in [0o644, 0o2755, 0o4755, 0o6777, 0o1777, 0o7777, 0o000]:
                for directory in (False, True):
                    path = dir_path if directory else file_path
                    os.chmod(path, start)
                    proc = subprocess.run(['chmod', digits, path], capture_output=True, text=True)
                    numeric.append({'digits': digits, 'start': start, 'dir': directory, 'status': proc.returncode,
                                    'result': stat.S_IMODE(os.stat(path).st_mode)})
        os.chmod(dir_path, 0o755)
        os.chmod(file_path, 0o644)
    finally:
        shutil.rmtree(root, ignore_errors=True)
    json.dump({'source': version, 'uid': os.getuid(), 'symbolic': cases, 'numeric': numeric}, sys.stdout, separators=(',', ':'))
    sys.stdout.write('\n')


if __name__ == '__main__':
    main()
