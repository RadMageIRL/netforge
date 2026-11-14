"""Checks NetForge's generated Terraform files with python-hcl2, an HCL2 parser written
independently of NetForge, and writes tests/fixtures/export-hcl-oracle.json.

    NETFORGE_WRITE_HCL_CASES=<cases.json> npx vitest run tests/unit/export-terraform-oracle.test.ts
    PYTHONPATH=<dir with python-hcl2> python scripts/oracles/export_hcl_oracle.py <cases.json> tests/fixtures/export-hcl-oracle.json

For each case:
1. python-hcl2 parses the text (kind tfvars-json is read by Python's json module instead).
2. python-hcl2 returns quoted strings as they are written in the file. They are decoded here,
   from the HCL native syntax specification: the escapes \\n \\r \\t \\" \\\\ \\uNNNN \\UNNNNNNNN,
   and the template escapes $${ and %%{. An unescaped ${ or %{ inside a string would be evaluated
   by Terraform and is reported as a problem, as is a raw line break.
3. The decoded data must equal the data the case expects.
4. For AWS files: the blocks, resource types and names, argument names (against lists written
   from the hashicorp/aws provider documentation), references and tags must be as expected.

This checks syntax and structure. It does not run Terraform and does not check anything against
the provider's schema.

A limitation of python-hcl2 8.2.0, worked around and recorded per case: it reads the escaped
template openers $${ and %%{ only when a closing brace follows ("$${x}" parses, "$${" does not,
and "$${" with a brace somewhere later swallows the text between). The HCL specification makes
$${ a literal ${ wherever it stands. For a file that python-hcl2 cannot read as it is and that
holds an escaped opener, each $${ and %%{ is swapped for a private-use character before parsing
and swapped back in the strings the parser returns, so the decoder below still sees and checks
the real escapes. Such cases are recorded with mode "markers"; all others with mode "direct".
"""
import hashlib
import json
import re
import sys

import hcl2

try:
    from importlib.metadata import version
    PARSER = 'python-hcl2 ' + version('python-hcl2')
except Exception:  # the package may be on PYTHONPATH without metadata
    PARSER = 'python-hcl2 (version unknown)'

BS = chr(92)
META_KEYS = ('__comments__', '__inline_comments__', '__start_line__', '__end_line__')
BLOCK = '__is_block__'
MARK_DOLLAR = chr(0xE000)
MARK_PERCENT = chr(0xE001)
ESCAPED_DOLLAR = '$$' + '{'
ESCAPED_PERCENT = '%%' + '{'
IDENTIFIER = re.compile(r'^[A-Za-z_][A-Za-z0-9_]*$')
RESOURCE_NAME = re.compile(r'^[a-z_][a-z0-9_]*$')

# Arguments this export may write, from the hashicorp/aws provider documentation.
ALLOWED_ARGUMENTS = {
    'aws_vpc': {'cidr_block', 'tags'},
    'aws_subnet': {'vpc_id', 'cidr_block', 'availability_zone', 'ipv6_cidr_block', 'depends_on', 'tags'},
    'aws_vpc_ipv6_cidr_block_association': {'vpc_id', 'ipv6_pool', 'ipv6_cidr_block'},
}


class Problem(Exception):
    pass


class Expr:
    """An HCL expression that is not a literal: a reference or a function call."""

    def __init__(self, text):
        self.text = text

    def __eq__(self, other):
        return isinstance(other, Expr) and other.text == self.text

    def __repr__(self):
        return 'Expr(%r)' % self.text


def unquote(text):
    """Decodes one HCL quoted string literal, quotes included."""
    if len(text) < 2 or text[0] != '"' or text[-1] != '"':
        raise Problem('not a quoted string: %r' % text[:40])
    body = text[1:-1]
    out = []
    i = 0
    n = len(body)
    while i < n:
        ch = body[i]
        if ch == BS:
            if i + 1 >= n:
                raise Problem('a backslash at the end of a string')
            nxt = body[i + 1]
            if nxt == 'n':
                out.append('\n')
            elif nxt == 'r':
                out.append('\r')
            elif nxt == 't':
                out.append('\t')
            elif nxt == '"':
                out.append('"')
            elif nxt == BS:
                out.append(BS)
            elif nxt == 'u' or nxt == 'U':
                width = 4 if nxt == 'u' else 8
                digits = body[i + 2:i + 2 + width]
                if len(digits) != width or not re.match(r'^[0-9A-Fa-f]+$', digits):
                    raise Problem('a malformed unicode escape')
                out.append(chr(int(digits, 16)))
                i += width
            else:
                raise Problem('an unknown escape: backslash %r' % nxt)
            i += 2
        elif ch in '$%':
            if body[i + 1:i + 3] == ch + '{':
                out.append(ch + '{')
                i += 3
            elif body[i + 1:i + 2] == '{':
                raise Problem('a live template sequence %s{ inside a string' % ch)
            else:
                out.append(ch)
                i += 1
        elif ch == '"':
            raise Problem('an unescaped quote inside a string')
        elif ch in '\n\r':
            raise Problem('a raw line break inside a string')
        else:
            out.append(ch)
            i += 1
    return ''.join(out)


def decode(node):
    """python-hcl2 output as plain data: strings decoded, expressions wrapped in Expr."""
    if isinstance(node, dict):
        out = {}
        for key, value in node.items():
            if key in META_KEYS:
                continue
            if key == BLOCK:
                out[BLOCK] = True
                continue
            name = unquote(key) if key.startswith('"') else key
            if not key.startswith('"') and not IDENTIFIER.match(key):
                raise Problem('an unquoted key that is not an identifier: %r' % key)
            if name in out:
                raise Problem('a key appears twice: %r' % name)
            out[name] = decode(value)
        return out
    if isinstance(node, list):
        return [decode(v) for v in node]
    if isinstance(node, str):
        if node.startswith('"'):
            return unquote(node)
        if node.startswith('${') and node.endswith('}'):
            return Expr(node[2:-1])
        if IDENTIFIER.match(node):
            return Expr(node)
        raise Problem('a string that is neither quoted nor an expression: %r' % node[:40])
    return node


def differences(actual, expected, path='', out=None):
    out = [] if out is None else out
    if len(out) >= 5:
        return out
    if isinstance(expected, dict):
        if not isinstance(actual, dict):
            out.append('%s: expected an object, found %s' % (path, type(actual).__name__))
        else:
            if list(actual.keys()) != list(expected.keys()):
                out.append('%s: keys %r, expected %r' % (path, list(actual.keys())[:8], list(expected.keys())[:8]))
            for key in expected:
                if key in actual:
                    differences(actual[key], expected[key], '%s.%s' % (path, key), out)
    elif isinstance(expected, list):
        if not isinstance(actual, list) or len(actual) != len(expected):
            out.append('%s: list differs' % path)
        else:
            for i, (a, e) in enumerate(zip(actual, expected)):
                differences(a, e, '%s[%d]' % (path, i), out)
    elif type(actual) is not type(expected) or actual != expected:
        out.append('%s: found %r, expected %r' % (path, actual, expected))
    return out


def blocks(doc, kind):
    """The blocks of one kind as (labels, body) pairs, in file order."""
    found = []
    for entry in doc.get(kind, []):
        labels = []
        body = entry
        while isinstance(body, dict) and BLOCK not in body and len(body) == 1:
            labels.append(next(iter(body)))
            body = body[labels[-1]]
        if not isinstance(body, dict) or BLOCK not in body:
            raise Problem('a %s entry that is not a block' % kind)
        found.append((labels, {k: v for k, v in body.items() if k != BLOCK}))
    return found


def check_declarations(doc, expected):
    problems = []
    if set(doc.keys()) != {'variable'}:
        problems.append('top-level blocks: %r' % sorted(doc.keys()))
    names = []
    for labels, body in blocks(doc, 'variable'):
        names.append(labels[0] if labels else None)
        if set(body.keys()) != {'description', 'type'}:
            problems.append('variable %r has arguments %r' % (labels, sorted(body.keys())))
        if not isinstance(body.get('description'), str) or not isinstance(body.get('type'), Expr):
            problems.append('variable %r: description must be a string and type an expression' % labels)
    if names != expected:
        problems.append('variables %r, expected %r' % (names, expected))
    return problems


def check_aws(doc, expected):
    problems = []
    if not set(doc.keys()) <= {'terraform', 'variable', 'resource'}:
        problems.append('unexpected top-level blocks: %r' % sorted(doc.keys()))
    tf = blocks(doc, 'terraform')
    if len(tf) != 1:
        problems.append('expected one terraform block')
    else:
        body = tf[0][1]
        if set(body.keys()) != {'required_version', 'required_providers'}:
            problems.append('terraform block arguments: %r' % sorted(body.keys()))
        if body.get('required_version') != expected['terraform']:
            problems.append('required_version %r' % (body.get('required_version'),))
        providers = body.get('required_providers')
        if providers != [{'aws': {'source': 'hashicorp/aws', 'version': expected['provider']}, BLOCK: True}]:
            problems.append('required_providers %r' % (providers,))
    variables = {}
    for labels, body in blocks(doc, 'variable'):
        variables[labels[0] if labels else None] = body
    wanted = ['netforge_availability_zones'] + (['netforge_ipv6_pool'] if expected['assoc'] else [])
    if list(variables.keys()) != wanted:
        problems.append('variables %r, expected %r' % (list(variables.keys()), wanted))
    for name, body in variables.items():
        if set(body.keys()) != {'description', 'type'}:
            problems.append('variable %s has arguments %r (a default would invent a value)' % (name, sorted(body.keys())))
    if variables.get('netforge_availability_zones', {}).get('type') != Expr('map(string)'):
        problems.append('netforge_availability_zones is not map(string)')

    vpc = expected['vpc']
    assoc = expected['assoc']
    want = [('aws_vpc', vpc['name'])]
    if assoc:
        want.append(('aws_vpc_ipv6_cidr_block_association', assoc['name']))
    want += [('aws_subnet', s['name']) for s in expected['subnets']]
    got = []
    bodies = {}
    for labels, body in blocks(doc, 'resource'):
        if len(labels) != 2:
            problems.append('a resource block with labels %r' % (labels,))
            continue
        got.append((labels[0], labels[1]))
        bodies[(labels[0], labels[1])] = body
        allowed = ALLOWED_ARGUMENTS.get(labels[0])
        if allowed is None:
            problems.append('resource type %s is outside the documented subset' % labels[0])
        elif not set(body.keys()) <= allowed:
            problems.append('%s.%s has arguments outside the list: %r' % (labels[0], labels[1], sorted(set(body.keys()) - allowed)))
        if not RESOURCE_NAME.match(labels[1]):
            problems.append('resource name %r is not a plain identifier' % labels[1])
    if got != want:
        problems.append('resources %r, expected %r' % (got[:6], want[:6]))
    if len(set(got)) != len(got):
        problems.append('a resource name is used twice')
    if problems:
        return problems

    def same(what, actual, wanted_value):
        if type(actual) is not type(wanted_value) or actual != wanted_value:
            problems.append('%s: found %r, expected %r' % (what, actual, wanted_value))

    body = bodies[('aws_vpc', vpc['name'])]
    same('vpc cidr_block', body.get('cidr_block'), vpc['cidr'])
    same('vpc tags', body.get('tags', {}), vpc['tags'])
    vpc_id = Expr('aws_vpc.%s.id' % vpc['name'])
    if assoc:
        body = bodies[('aws_vpc_ipv6_cidr_block_association', assoc['name'])]
        same('association', body, {'vpc_id': vpc_id, 'ipv6_pool': Expr('var.netforge_ipv6_pool'), 'ipv6_cidr_block': assoc['cidr']})
    for s in expected['subnets']:
        body = bodies[('aws_subnet', s['name'])]
        where = 'aws_subnet.%s' % s['name']
        same(where + ' vpc_id', body.get('vpc_id'), vpc_id)
        same(where + ' cidr_block', body.get('cidr_block'), s['cidr'])
        same(where + ' availability_zone', body.get('availability_zone'), Expr('var.netforge_availability_zones["%s"]' % s['name']))
        same(where + ' tags', body.get('tags', {}), s['tags'])
        if s['ipv6'] is None:
            if 'ipv6_cidr_block' in body or 'depends_on' in body:
                problems.append(where + ' has IPv6 arguments it should not have')
        else:
            same(where + ' ipv6_cidr_block', body.get('ipv6_cidr_block'), s['ipv6'])
            same(where + ' depends_on', body.get('depends_on'), [Expr('aws_vpc_ipv6_cidr_block_association.%s' % assoc['name'])] if assoc else None)
    return problems


def restore(node):
    """Puts the escaped template openers back into what python-hcl2 returned."""
    if isinstance(node, dict):
        return {restore(k): restore(v) for k, v in node.items()}
    if isinstance(node, list):
        return [restore(v) for v in node]
    if isinstance(node, str):
        return node.replace(MARK_DOLLAR, ESCAPED_DOLLAR).replace(MARK_PERCENT, ESCAPED_PERCENT)
    return node


def attempt(case, markers):
    """Returns (parsed, problems) for one reading of a case."""
    kind = case['kind']
    text = case['text']
    try:
        if kind == 'tfvars-json':
            doc = json.loads(text)
        elif markers:
            if MARK_DOLLAR in text or MARK_PERCENT in text:
                return False, ['the case text uses the marker characters']
            doc = decode(restore(hcl2.loads(text.replace(ESCAPED_DOLLAR, MARK_DOLLAR).replace(ESCAPED_PERCENT, MARK_PERCENT))))
        else:
            doc = decode(hcl2.loads(text))
    except Problem as e:
        return True, [str(e)]
    except Exception as e:  # a parse error
        return False, ['parse error: %s' % str(e).split('\n')[0][:200]]
    try:
        if kind in ('value', 'tfvars', 'tfvars-json'):
            return True, differences(doc, case['expected'])
        if kind == 'declarations':
            return True, check_declarations(doc, case['expected'])
        if kind == 'aws':
            return True, check_aws(doc, case['expected'])
    except Problem as e:
        return True, [str(e)]
    return True, ['unknown kind %s' % kind]


def run(case):
    text = case['text']
    parsed, problems = attempt(case, False)
    mode = 'direct'
    if (not parsed or problems) and case['kind'] != 'tfvars-json' and (ESCAPED_DOLLAR in text or ESCAPED_PERCENT in text):
        parsed, problems = attempt(case, True)
        mode = 'markers'
    return {'id': case['id'], 'kind': case['kind'], 'sha256': hashlib.sha256(text.encode('utf-8')).hexdigest(), 'mode': mode, 'parsed': parsed, 'problems': problems}


def probe(text):
    try:
        hcl2.loads(text)
        return 'parsed'
    except Exception:
        return 'not parsed'


def main():
    if len(sys.argv) != 3:
        sys.exit('usage: export_hcl_oracle.py <cases.json> <fixture.json>')
    with open(sys.argv[1], 'r', encoding='utf-8') as f:
        cases = json.load(f)['cases']
    results = [run(c) for c in cases]
    # The limitation that mode "markers" works around, shown on fixed inputs.
    probes = {
        'escaped opener with a closing brace': probe('v = "' + ESCAPED_DOLLAR + 'x}"\n'),
        'escaped opener without a closing brace': probe('v = "' + ESCAPED_DOLLAR + '"\n'),
        'escaped directive opener without a closing brace': probe('v = "' + ESCAPED_PERCENT + '"\n'),
    }
    with open(sys.argv[2], 'w', encoding='utf-8', newline='\n') as f:
        json.dump({'parser': PARSER, 'probes': probes, 'results': results}, f, ensure_ascii=True, indent=1)
        f.write('\n')
    bad = [r for r in results if not r['parsed'] or r['problems']]
    print('%d cases, %d with problems, %d read in marker mode (%s)' % (len(results), len(bad), sum(1 for r in results if r['mode'] == 'markers'), PARSER))
    print(probes)
    for r in bad[:25]:
        print(' ', r['id'], '| parsed' if r['parsed'] else '| NOT parsed', '|', '; '.join(r['problems'])[:300])


if __name__ == '__main__':
    main()
