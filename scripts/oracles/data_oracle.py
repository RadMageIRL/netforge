#!/usr/bin/env python3
"""Independent references for NetForge's YAML and XML tools.

Writes tests/fixtures/data-oracle.json:

  yaml   Documents with the value PyYAML (yaml.safe_load, YAML 1.1) reads from them, as JSON.
         Only constructs that YAML 1.1 and YAML 1.2 read the same way are used, because NetForge
         follows YAML 1.2. Left out on purpose, because the two versions disagree or JSON cannot
         hold the result:
           - yes/no/on/off/y/n as plain scalars (booleans in 1.1, strings in 1.2)
           - octal (0o17 is 1.2 only; 017 is octal in 1.1 and decimal in 1.2)
           - digits with underscores, sexagesimal numbers (1:30), timestamps and dates
           - floats written with an exponent but no decimal point or exponent sign (1e3)
           - merge keys (<<), "=" values, !!binary, !!set, !!omap, !!timestamp, custom tags
           - .inf and .nan (no JSON form)
           - mapping keys that are not strings or plain decimal integers
  xml    Documents with expat's verdict, without and with namespace processing, and for accepted
         documents the events expat reports as a tree. Cases where NetForge differs by design are
         labeled:
           - entity      uses an entity declared in the DOCTYPE; expat expands it, NetForge refuses
           - dtd-default the DOCTYPE gives an attribute default; expat applies it, NetForge does not
           - version     an XML declaration with a version other than 1.0; expat does not check it
         Names are limited to characters that the fourth edition of XML 1.0 (expat) and the fifth
         (NetForge) both allow. Unpaired surrogates cannot be given to expat and are not included.

Deterministic: the same output on every run (seeded generators, sorted where order is free).

  python scripts/oracles/data_oracle.py
"""
import json
import os
import random
import re
import sys
import xml.parsers.expat as expat

import yaml

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
OUT = os.path.join(ROOT, 'tests', 'fixtures', 'data-oracle.json')

NL = chr(10)
TAB = chr(9)
CR = chr(13)
BS = chr(92)


def lines(*rows):
    return NL.join(rows) + NL


# YAML ------------------------------------------------------------------------------------------

YAML_HAND = [
    ('mapping', lines('a: 1', 'b: two', 'c: 3.5', 'd: true', 'e: false', 'f: null', 'g: ~', 'h:')),
    ('sequence', lines('- 1', '- two', '- 3.5', '- [4, five]', '- {k: v}')),
    ('nested block', lines('servers:', '  - name: web', '    ports: [80, 443]', '    tls:', '      enabled: true', '      versions:', '        - "1.2"', '        - "1.3"', '  - name: db', '    ports: []', '    tls: {}')),
    ('quoted strings', lines('a: "double"', "b: 'single'", 'c: "with ' + BS + '"escape' + BS + '" and ' + BS + 'n newline"', "d: 'it''s'", 'e: "' + BS + 'u00e9' + BS + 't' + BS + BS + '"', 'f: "123"', "g: 'true'", 'h: "null"', 'i: ""', "j: ''")),
    ('plain strings', lines('a: hello world', 'b: a-b_c.d', 'c: x:y', 'd: path/to/file.txt', 'e: 10.0.0.1', 'f: 1.2.3', 'g: v1', 'h: -x', 'i: a#b', 'j: "a # b"', 'k: end # comment')),
    ('integers', lines('- 0', '- 7', '- -12', '- +3', '- 2147483648', '- 9007199254740993', '- 12345678901234567890', '- -98765432109876543210', '- 0x1F', '- 0xff')),
    ('floats', lines('- 1.5', '- -0.25', '- 3.0', '- 1.0e+3', '- 2.5E-2', '- 100.0', '- .5', '- 0.1')),
    ('booleans and nulls', lines('- true', '- false', '- True', '- FALSE', '- null', '- Null', '- NULL', '- ~', '-')),
    ('literal block', lines('text: |', '  line one', '  line two', '', '  after blank', 'next: 1')),
    ('literal strip and keep', lines('strip: |-', '  no newline', 'keep: |+', '  two newlines', '', 'clip: |', '  one newline', '')),
    ('folded block', lines('text: >', '  folded', '  into one', '', '  second paragraph', 'more: >-', '  a', '  b')),
    ('indented block', lines('code: |2', '    indented', '  base', 'x: 1')),
    ('flow collections', lines('a: [1, [2, 3], {b: c, d: [e]}]', 'b: {x: 1, y: {z: [1, 2]}}', 'c: [ ]', 'd: { }', 'e: [a, b,]')),
    ('multi-line flow', lines('a: [', '  1,', '  2', ']', 'b: {', '  k: v', '}')),
    ('anchors and aliases', lines('base: &b', '  x: 1', '  y: [1, 2]', 'copy: *b', 'list:', '  - &s shared', '  - *s', '  - *b')),
    ('anchor on scalar and sequence', lines('- &a 5', '- *a', '- &l [1, 2]', '- *l', '- {k: *a}')),
    ('comments everywhere', lines('# head', 'a: 1 # tail', '', '# between', 'b:', '  # inside', '  - x # item', '  - y', '# end')),
    ('document markers', lines('---', 'a: 1', '...')),
    ('root scalar', lines('just a string')),
    ('root number', lines('42')),
    ('root list of maps', lines('- a: 1', '  b: 2', '- a: 3', '  b: 4')),
    ('compact nested sequences', lines('- - 1', '  - 2', '- - 3', '  - - 4', '    - 5')),
    ('explicit keys', lines('? simple', ': value', '? "quoted key"', ': 2')),
    ('integer keys', lines('1: one', '2: two', '10: ten')),
    ('empty values', lines('a:', 'b: ', 'c: []', 'd: {}', 'e: ""')),
    ('non-ASCII', lines('name: caf' + chr(0xe9), 'cjk: ' + chr(0x4e2d) + chr(0x6587), 'emoji: "' + chr(0x1f600) + '"', chr(0xe9) + 'cole: 1')),
    ('special characters in strings', lines('a: "tab' + BS + 'there"', 'b: "back' + BS + BS + 'slash"', 'c: "quote' + BS + '"s"', "d: 'colon: here'", 'e: "#hash"', 'f: "- dash"', 'g: "[bracket"', 'h: "{brace"', 'i: "*star"', 'j: "&amp"', 'k: "!bang"', 'l: "%pct"', 'm: "@at"')),
    ('explicit core tags', lines('a: !!str 123', 'b: !!int "7"', 'c: !!float "1.5"', 'd: !!bool "true"', 'e: !!null ""', 'f: !!str true')),
    ('windows line endings', 'a: 1' + CR + NL + 'b:' + CR + NL + '  - x' + CR + NL + '  - y' + CR + NL),
    ('trailing spaces and blank lines', lines('a: 1   ', '', '', 'b: 2', '  ', 'c: 3')),
    ('long plain multi-line scalar', lines('a: first', '  second', '  third', 'b: x')),
    ('nested empty', lines('a:', '  b:', '    c:', 'd: [[], [[]], {}]')),
    ('json is yaml', '{"a": [1, 2.5, "x", true, false, null], "b": {"c": "d"}}' + NL),
    ('deep nesting', lines(*[('  ' * i) + 'k%d:' % i for i in range(30)], ('  ' * 30) + 'leaf: 1')),
    ('keys needing quotes', lines('"a: b": 1', '"#c": 2', "'- d': 3", '"": 4', '" lead": 5', '"trail ": 6')),
]

YAML_MULTI = [
    ('two documents', lines('a: 1', '---', 'b: 2')),
    ('three with markers', lines('---', '- x', '---', 'k: v', '...', '---', 'last')),
    ('document with comment', lines('# first', 'a: 1', '--- # second', 'b: 2')),
    ('empty middle document', lines('a: 1', '---', '---', 'c: 3')),
]

YAML_INVALID = [
    ('bad indentation', lines('a: 1', ' b: 2')),
    ('unclosed flow sequence', lines('a: [1, 2')),
    ('unclosed double quote', lines('a: "open')),
    ('tab indentation', 'a:' + NL + TAB + 'b: 1' + NL),
    ('mapping value in sequence entry', lines('- a: 1', '  b', '  c: 2')),
    ('unknown alias', lines('a: *missing')),
    ('unclosed flow mapping', lines('a: {b: 1')),
    ('bad escape', lines('a: "' + BS + 'q"')),
    ('two values', lines('a: 1: 2: 3', '- x')),
    ('stray bracket', lines('a: ]')),
]

WORDS = ['alpha', 'beta', 'gamma', 'delta', 'web', 'db', 'prod', 'eu-west', 'node_1', 'v2', 'Hello World', 'x', 'A', 'path/to', 'a.b.c', 'key', 'value', 'item']
ODD = ['', ' ', ' lead', 'trail ', 'a: b', '#c', 'a #b', '- x', '?', ':', '-', '"q"', "it's", 'tab' + TAB + 'x', 'line' + NL + 'two', NL, 'end' + NL, 'a' + NL + NL + 'b', 'back' + BS + 'slash',
       '{x', '[y', '*z', '&w', '!t', '%p', '@a', '`b', '|', '>', ',', 'caf' + chr(0xe9), chr(0x4e2d) + chr(0x6587), chr(0x1f600), 'a' + chr(0xa0) + 'b', 'true', 'null', '123', '1.5', '~', 'True', 'NULL', '0x10',
       '-1', '+1', '.5', '1.', 'x' * 120, 'word ' * 30]

# Plain scalars that YAML 1.1 and 1.2 type differently. A random string that looks like one is not used.
RISKY = re.compile(r'^(y|Y|yes|Yes|YES|n|N|no|No|NO|on|On|ON|off|Off|OFF|=|<<)$|^[-+]?0o?[0-7_]+$|^[-+]?[0-9][0-9_]*(:[0-5]?[0-9])+|_|^[-+]?[0-9.]+[eE]|^[0-9]{4}-[0-9]{1,2}-[0-9]{1,2}|^[-+]?0b[01_]+$|^[-+]?\.(inf|Inf|INF)$|^\.(nan|NaN|NAN)$')


def yaml_string(rng):
    for _ in range(50):
        s = rng.choice(WORDS) if rng.random() < 0.6 else rng.choice(ODD)
        if rng.random() < 0.15:
            s = s + rng.choice([' ', '-', ':', '#', '']) + rng.choice(WORDS)
        if not RISKY.search(s) and NL + ' ' not in s:
            return s
    return 'fallback'


def yaml_value(rng, depth):
    roll = rng.random()
    if depth > 4 or roll < 0.35:
        return yaml_string(rng)
    if roll < 0.47:
        return rng.choice([0, 1, -1, 7, 42, 65535, -2147483648, 10 ** 12, 9007199254740993, 12345678901234567890, -(10 ** 25)])
    if roll < 0.53:
        return rng.choice([0.5, -0.25, 1.5, 2.75, 100.125, -3.5])
    if roll < 0.60:
        return rng.choice([True, False, None])
    if roll < 0.80:
        return [yaml_value(rng, depth + 1) for _ in range(rng.randint(0, 4))]
    out = {}
    for _ in range(rng.randint(0, 4)):
        key = yaml_string(rng)
        if NL in key or len(key) > 60:
            continue
        out[key] = yaml_value(rng, depth + 1)
    return out


def yaml_cases():
    cases = []
    for name, text in YAML_HAND:
        value = yaml.safe_load(text)
        cases.append({'name': name, 'yaml': text, 'json': json.dumps(value, ensure_ascii=False, separators=(',', ':')), 'documents': 1})
    for name, text in YAML_MULTI:
        docs = list(yaml.safe_load_all(text))
        cases.append({'name': name, 'yaml': text, 'json': json.dumps(docs, ensure_ascii=False, separators=(',', ':')), 'documents': len(docs)})
    for name, text in YAML_INVALID:
        try:
            list(yaml.safe_load_all(text))
        except yaml.YAMLError:
            cases.append({'name': name, 'yaml': text, 'json': None, 'documents': 0})
        else:
            raise SystemExit('PyYAML accepts the "%s" case, so it is not a usable invalid case' % name)
    rng = random.Random(4406)
    made = 0
    while made < 300:
        value = yaml_value(rng, 0)
        style = rng.choice([False, False, True, None])
        text = yaml.safe_dump(value, default_flow_style=style, allow_unicode=True, sort_keys=False, width=rng.choice([40, 80, 100000]), indent=rng.choice([2, 4]))
        if yaml.safe_load(text) != value:
            raise SystemExit('PyYAML does not round-trip its own output: %r' % (value,))
        made += 1
        cases.append({'name': 'random %d (%s)' % (made, {False: 'block', True: 'flow', None: 'mixed'}[style]), 'yaml': text,
                      'json': json.dumps(value, ensure_ascii=False, separators=(',', ':')), 'documents': 1, 'exact': True})
    return cases


# XML -------------------------------------------------------------------------------------------

# A character that cannot occur in XML, so no namespace name can contain it (expat refuses a
# namespace name that contains the separator).
SEPARATOR = chr(1)


class Builder:
    """Turns expat events into the same tree shape the test builds from NetForge's parser."""

    def __init__(self, namespaces):
        self.parser = expat.ParserCreate(namespace_separator=SEPARATOR) if namespaces else expat.ParserCreate()
        self.parser.ordered_attributes = True
        self.parser.buffer_text = False
        self.before, self.after, self.root = [], [], None
        self.stack = []
        self.text = None
        self.cdata = None
        self.in_doctype = False
        p = self.parser
        p.StartElementHandler = self.start
        p.EndElementHandler = self.end
        p.CharacterDataHandler = self.chars
        p.CommentHandler = self.comment
        p.ProcessingInstructionHandler = self.pi
        p.StartCdataSectionHandler = self.cdata_start
        p.EndCdataSectionHandler = self.cdata_end
        p.StartDoctypeDeclHandler = self.doctype_start
        p.EndDoctypeDeclHandler = self.doctype_end

    def siblings(self):
        if self.stack:
            return self.stack[-1][3]
        return self.before if self.root is None else self.after

    def flush(self):
        if self.text is not None:
            if self.stack:
                self.stack[-1][3].append(['t', self.text])
            self.text = None

    def start(self, name, attrs):
        self.flush()
        node = ['e', name, [[attrs[i], attrs[i + 1]] for i in range(0, len(attrs), 2)], []]
        if self.stack:
            self.stack[-1][3].append(node)
        else:
            self.root = node
        self.stack.append(node)

    def end(self, _name):
        self.flush()
        self.stack.pop()

    def chars(self, data):
        if self.cdata is not None:
            self.cdata += data
        else:
            self.text = (self.text or '') + data

    def cdata_start(self):
        self.flush()
        self.cdata = ''

    def cdata_end(self):
        self.stack[-1][3].append(['cd', self.cdata])
        self.cdata = None

    def comment(self, data):
        if self.in_doctype:
            return
        self.flush()
        self.siblings().append(['c', data])

    def pi(self, target, data):
        if self.in_doctype:
            return
        self.flush()
        self.siblings().append(['pi', target, data])

    def doctype_start(self, *_args):
        self.in_doctype = True

    def doctype_end(self):
        self.in_doctype = False

    def run(self, text):
        try:
            self.parser.Parse(text, True)
        except expat.ExpatError as error:
            return None, expat.errors.messages[error.code]
        return {'before': self.before, 'root': self.root, 'after': self.after}, None


XML_HAND = [
    # (name, text, design label or None)
    ('minimal', '<a/>', None),
    ('empty pair', '<a></a>', None),
    ('declaration', '<?xml version="1.0" encoding="UTF-8"?>' + NL + '<a/>', None),
    ('declaration standalone', "<?xml version='1.0' standalone='yes'?><a/>", None),
    ('every node type', '<?xml version="1.0"?><!-- before --><?style sheet?><root a="1" b=\'two\'>text<child/><![CDATA[<raw> & ]]><!-- in --><?pi data here?><empty></empty></root><!-- after --><?end?>', None),
    ('whitespace layout', '<r>' + NL + '  <a>' + NL + '    <b/>' + NL + '  </a>' + NL + '</r>' + NL, None),
    ('mixed content', '<p>Some <b>bold</b> and <i>italic <u>deep</u></i> text.</p>', None),
    ('predefined entities', '<a x="&lt;&gt;&amp;&apos;&quot;">&lt;&gt;&amp;&apos;&quot;</a>', None),
    ('numeric references', '<a x="&#65;&#x42;">&#65;&#x42;&#x1F600;&#169;&#9;&#10;&#13;</a>', None),
    ('double escape', '<a>&amp;lt; &#38;amp;</a>', None),
    ('attribute normalization', '<a x="a' + TAB + 'b' + NL + 'c' + CR + NL + 'd" y="a&#9;b&#10;c"/>', None),
    ('line ends in text', '<a>one' + CR + NL + 'two' + CR + 'three</a>', None),
    ('line ends in cdata', '<a><![CDATA[x' + CR + NL + 'y]]></a>', None),
    ('quotes in attributes', '<a x="it\'s > ok" y=\'say "hi"\'/>', None),
    ('cdata edge cases', '<a><![CDATA[]]><![CDATA[<b>&amp;]]]]><![CDATA[>]]></a>', None),
    ('text around cdata', '<a>before<![CDATA[mid]]>after</a>', None),
    ('comments', '<a><!----><!-- - - > --><!-- a > b & c --></a>', None),
    ('processing instructions', '<a><?p?><?q   spaced  ?><?r a?b ?></a>', None),
    ('whitespace in tags', '<a  x = "1"' + NL + ' y="2" ><b' + TAB + '/></a >', None),
    ('non-ASCII content', '<a n="caf' + chr(0xe9) + '">' + chr(0x4e2d) + chr(0x6587) + ' ' + chr(0x1f600) + '</a>', None),
    ('non-ASCII names', '<' + chr(0xe9) + 'l ' + chr(0x3b1) + '="1"><' + chr(0x4e2d) + '/></' + chr(0xe9) + 'l>', None),
    ('name characters', '<_a-b.c1 x_y-z.1="v"/>', None),
    ('bom', chr(0xfeff) + '<?xml version="1.0"?><a/>', None),
    ('allowed controls', '<a>' + TAB + NL + chr(0x7f) + chr(0x85) + chr(0xfffd) + '</a>', None),
    ('gt in text', '<a>a > b ]] > ]></a>', None),
    ('doctype simple', '<!DOCTYPE a><a/>', None),
    ('doctype system', '<!DOCTYPE a SYSTEM "a.dtd"><a>t</a>', None),
    ('doctype public', '<!DOCTYPE a PUBLIC "-//X//Y" "http://example.invalid/a.dtd"><a/>', None),
    ('doctype internal subset', '<!DOCTYPE a [<!ELEMENT a (#PCDATA)><!-- c ] > --><?p in dtd?>]><a>t</a>', None),
    ('doctype with unused entities', '<!DOCTYPE a [<!ENTITY x "]>"><!ENTITY y \']]>\'>]><a>t</a>', None),
    ('comment before doctype', '<!-- one --><?p a?><!DOCTYPE r><!-- two --><r/>', None),
    ('default namespace', '<r xmlns="urn:d"><a/><b xmlns=""><c/></b></r>', None),
    ('prefixed namespaces', '<p:r xmlns:p="urn:p" p:x="1"><p:a/><q:b xmlns:q="urn:q" q:y="2" p:z="3"/></p:r>', None),
    ('xml prefix', '<r xml:lang="en" xml:space="preserve"> <a/> </r>', None),
    ('namespace shadowing', '<r xmlns:p="urn:1"><p:a xmlns:p="urn:2"><p:b/></p:a><p:c/></r>', None),
    ('many attributes', '<a ' + ' '.join('k%d="%d"' % (i, i) for i in range(40)) + '/>', None),
    ('deep nesting', '<a>' * 60 + 'x' + '</a>' * 60, None),
    ('trailing misc', '<a/>' + NL + '<!-- c -->' + NL + '<?p?>' + NL, None),
    # Design differences.
    ('internal entity used', '<!DOCTYPE a [<!ENTITY x "expanded">]><a>&x;</a>', 'entity'),
    ('internal entity in attribute', '<!DOCTYPE a [<!ENTITY x "expanded">]><a k="&x;"/>', 'entity'),
    ('nested entities used', '<!DOCTYPE a [<!ENTITY x "one"><!ENTITY y "&x;&x;">]><a>&y;</a>', 'entity'),
    ('attribute default from DTD', '<!DOCTYPE a [<!ATTLIST a k CDATA "dflt">]><a/>', 'dtd-default'),
    ('version 1.1', '<?xml version="1.1"?><a/>', 'version'),
    ('carriage return reference', '<a x="&#13;">a&#13;b&#xD;&#10;</a>', None),
    ('namespace name with spaces', '<r xmlns:p=" urn:x y "><p:a/></r>', None),
    # Not well-formed.
    ('empty', '', None),
    ('only whitespace', '  ' + NL, None),
    ('only comment', '<!-- c -->', None),
    ('only declaration', '<?xml version="1.0"?>', None),
    ('unclosed root', '<a>', None),
    ('unclosed child', '<a><b></a>', None),
    ('crossed tags', '<a><b></a></b>', None),
    ('case mismatch', '<a></A>', None),
    ('stray close', '</a>', None),
    ('two roots', '<a/><b/>', None),
    ('text before root', 'x<a/>', None),
    ('text after root', '<a/>x', None),
    ('reference after root', '<a/>&amp;', None),
    ('cdata outside root', '<![CDATA[x]]><a/>', None),
    ('cdata after root', '<a/><![CDATA[x]]>', None),
    ('duplicate attribute', '<a x="1" x="2"/>', None),
    ('unquoted attribute', '<a x=1/>', None),
    ('attribute without value', '<a x/>', None),
    ('lt in attribute', '<a x="a<b"/>', None),
    ('unclosed attribute', '<a x="1/>', None),
    ('attributes not separated', '<a x="1"y="2"/>', None),
    ('bare ampersand', '<a>a & b</a>', None),
    ('unterminated reference', '<a>&amp</a>', None),
    ('unknown entity', '<a>&nbsp;</a>', None),
    ('unknown entity in attribute', '<a x="&copy;"/>', None),
    ('bad character reference', '<a>&#xZZ;</a>', None),
    ('empty character reference', '<a>&#;</a>', None),
    ('reference to nul', '<a>&#0;</a>', None),
    ('reference to control', '<a>&#8;</a>', None),
    ('reference to surrogate', '<a>&#xD800;</a>', None),
    ('reference to fffe', '<a>&#xFFFE;</a>', None),
    ('reference beyond unicode', '<a>&#x110000;</a>', None),
    ('control character', '<a>' + chr(1) + '</a>', None),
    ('form feed', '<a>' + chr(12) + '</a>', None),
    ('control in attribute', '<a x="' + chr(8) + '"/>', None),
    ('fffe character', '<a>' + chr(0xfffe) + '</a>', None),
    ('ffff character', '<a>' + chr(0xffff) + '</a>', None),
    ('cdata end in text', '<a>x]]>y</a>', None),
    ('double hyphen in comment', '<a><!-- a -- b --></a>', None),
    ('comment ending with hyphen', '<a><!-- a ---></a>', None),
    ('unclosed comment', '<a><!-- x</a>', None),
    ('unclosed cdata', '<a><![CDATA[x</a>', None),
    ('unclosed pi', '<a><?p x</a>', None),
    ('pi without space', '<a><?p!x?></a>', None),
    ('late declaration', ' <?xml version="1.0"?><a/>', None),
    ('declaration after comment', '<!-- c --><?xml version="1.0"?><a/>', None),
    ('declaration inside', '<a><?xml version="1.0"?></a>', None),
    ('declaration wrong order', '<?xml encoding="UTF-8" version="1.0"?><a/>', None),
    ('declaration without version', '<?xml encoding="UTF-8"?><a/>', None),
    ('declaration bad standalone', '<?xml version="1.0" standalone="maybe"?><a/>', None),
    ('declaration unclosed', '<?xml version="1.0"><a/>', None),
    ('name starts with digit', '<1a/>', None),
    ('name starts with hyphen', '<-a/>', None),
    ('space before name', '< a/>', None),
    ('attribute name starts with digit', '<a 1x="1"/>', None),
    ('slash space', '<a/ >', None),
    ('junk in close tag', '<a></a b>', None),
    ('bad markup declaration', '<a><!x></a>', None),
    ('lowercase cdata', '<a><![cdata[x]]></a>', None),
    ('doctype after root', '<a/><!DOCTYPE a>', None),
    ('doctype inside', '<a><!DOCTYPE a></a>', None),
    ('two doctypes', '<!DOCTYPE a><!DOCTYPE a><a/>', None),
    ('doctype without name', '<!DOCTYPE><a/>', None),
    ('doctype unclosed subset', '<!DOCTYPE a [<a/>', None),
    ('lowercase doctype', '<!doctype a><a/>', None),
    ('element declaration outside doctype', '<!ELEMENT a ANY><a/>', None),
    ('double colon name', '<a:b:c xmlns:a="urn:a"/>', None),
    ('double colon attribute', '<r xmlns:a="urn:a" a:b:c="1"/>', None),
    ('leading colon name', '<:a/>', None),
    ('trailing colon name', '<a:/>', None),
    ('unbound element prefix', '<r><p:a/></r>', None),
    ('unbound root prefix', '<p:r/>', None),
    ('unbound attribute prefix', '<r p:x="1"/>', None),
    ('prefix out of scope', '<r><a xmlns:p="urn:p"/><p:b/></r>', None),
    ('duplicate expanded attribute', '<r xmlns:a="urn:s" xmlns:b="urn:s" a:x="1" b:x="2"/>', None),
    ('xmlns prefix declared', '<r xmlns:xmlns="urn:x"/>', None),
    ('xml prefix rebound', '<r xmlns:xml="urn:other"/>', None),
    ('xml namespace on other prefix', '<r xmlns:p="http://www.w3.org/XML/1998/namespace"/>', None),
    ('empty prefix declaration', '<r xmlns:p=""/>', None),
    ('just lt', '<', None),
    ('unfinished tag', '<a', None),
    ('unfinished tag with attribute', '<a x="1"', None),
]

XML_NAMES = ['a', 'b', 'item', 'ns:c', 'p', 'row']
XML_TEXTS = ['text', ' ', NL, NL + '  ', 'a &amp; b', ' padded ', '&#169;', 'x' + TAB + 'y', '&lt;tag&gt;', 'caf' + chr(0xe9), 'q"uote' + "'s", 'a > b']
BREAKERS = ['<', '>', '&', '"', "'", '/', '=', ' ', ']', '-', '!', '?', ';', 'x']


def xml_node(rng, depth):
    roll = rng.random()
    if depth > 4 or roll < 0.22:
        return rng.choice(XML_TEXTS)
    if roll < 0.29:
        return '<!--' + rng.choice([' c ', '', ' a > b ', ' - ']) + '-->'
    if roll < 0.34:
        return '<![CDATA[' + rng.choice(['', 'x', '<y>&', ']] >']) + ']]>'
    if roll < 0.38:
        return '<?' + rng.choice(['pi', 'q']) + rng.choice(['', ' d', ' e f ']) + '?>'
    name = rng.choice(XML_NAMES)
    attrs = ''
    if rng.random() < 0.35:
        attrs += ' id="%d"' % rng.randint(0, 9)
    if rng.random() < 0.2:
        attrs += " q='say &quot;hi&quot; " + rng.choice(['', '&amp;', 'a' + TAB + 'b', '&#10;']) + "'"
    if rng.random() < 0.1:
        attrs += ' ns:k="v"'
    if rng.random() < 0.2:
        return '<' + name + attrs + rng.choice(['/>', ' />'])
    inner = ''.join(xml_node(rng, depth + 1) for _ in range(rng.randint(0, 4)))
    return '<' + name + attrs + '>' + inner + '</' + name + '>'


def xml_random(rng):
    body = ''.join(xml_node(rng, 1) for _ in range(rng.randint(1, 4)))
    head = rng.choice(['', '', '<?xml version="1.0"?>', '<?xml version="1.0" encoding="UTF-8"?>' + NL])
    lead = rng.choice(['', '', '<!-- lead -->', '<?lead x?>' + NL])
    tail = rng.choice(['', '', '<!-- tail -->', NL])
    return head + lead + '<root xmlns:ns="urn:n">' + body + '</root>' + tail


def damage(rng, text):
    at = rng.randrange(len(text))
    roll = rng.random()
    if roll < 0.4:
        return text[:at] + text[at + 1:]
    if roll < 0.7:
        return text[:at] + rng.choice(BREAKERS) + text[at:]
    return text[:at] + rng.choice(BREAKERS) + text[at + 1:]


# expat accepts any version number in the XML declaration; NetForge reads XML 1.0 only.
OTHER_VERSION = re.compile(r'^<\?xml version="(?!1\.0")')


def xml_case(name, text, design):
    plain, plain_error = Builder(False).run(text)
    spaced, spaced_error = Builder(True).run(text)
    case = {'name': name, 'xml': text, 'wellFormed': plain is not None, 'namespaceOk': spaced is not None}
    if plain is not None:
        case['tree'] = plain
    else:
        case['expatError'] = plain_error
    if plain is not None and spaced is None:
        case['expatNamespaceError'] = spaced_error
    if design:
        case['design'] = design
    return case


def xml_cases():
    cases = [xml_case(name, text, design) for name, text, design in XML_HAND]
    rng = random.Random(4407)
    for i in range(250):
        cases.append(xml_case('random %d' % (i + 1), xml_random(rng), None))
    made = 0
    while made < 500:
        text = damage(rng, xml_random(rng))
        if rng.random() < 0.3:
            text = damage(rng, text)
        # Damage can spell out things this corpus deliberately leaves to hand-written cases.
        if '<!DOCTYPE' in text or 'xmlns:ns=""' in text:
            continue
        made += 1
        case = xml_case('damaged %d' % made, text, None)
        if case['wellFormed'] and OTHER_VERSION.search(text):
            case['design'] = 'version'
        cases.append(case)
    return cases


def main():
    data = {
        'generator': 'scripts/oracles/data_oracle.py',
        'pyyaml': yaml.__version__,
        'expat': expat.EXPAT_VERSION,
        'yaml': yaml_cases(),
        'xml': xml_cases(),
    }
    text = json.dumps(data, ensure_ascii=True, sort_keys=True, separators=(',', ':')) + NL
    with open(OUT, 'wb') as handle:
        handle.write(text.encode('ascii'))
    y = data['yaml']
    x = data['xml']
    print('yaml cases: %d (%d invalid, %d multi-document)' % (len(y), sum(1 for c in y if c['json'] is None), sum(1 for c in y if c['documents'] > 1)))
    print('xml cases: %d (%d well-formed, %d rejected, %d namespace-only rejections, %d design differences)' % (
        len(x), sum(1 for c in x if c['wellFormed']), sum(1 for c in x if not c['wellFormed']),
        sum(1 for c in x if c['wellFormed'] and not c['namespaceOk']), sum(1 for c in x if 'design' in c)))


if __name__ == '__main__':
    sys.exit(main())
