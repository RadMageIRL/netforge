/**
 * Every NetForge tool, built or planned. Adding a tool means adding an entry here and, for a built
 * tool, a module under src/tools/. Planned tools are listed and clearly labeled as not built yet.
 */
import { ToolRegistry } from './registry';

export function createCatalog(): ToolRegistry {
  const r = new ToolRegistry();
  r.addCategory({ id: 'network', name: 'Network' })
    .addCategory({ id: 'scheduling', name: 'Scheduling' })
    .addCategory({ id: 'data', name: 'Data' })
    .addCategory({ id: 'encoding', name: 'Encoding' })
    .addCategory({ id: 'text', name: 'Text' })
    .addCategory({ id: 'generators', name: 'Generators' })
    .addCategory({ id: 'automation', name: 'Automation / DevOps' });

  // Network
  r.add({
    id: 'subnet-calculator', name: 'Subnet Calculator', category: 'network', status: 'available',
    summary: 'IPv4 and IPv6 networks: boundaries, masks, address counts, classification, splits and supernets.',
    keywords: ['cidr', 'ipv4', 'ipv6', 'ip', 'subnet', 'mask', 'netmask', 'wildcard', 'broadcast', 'prefix', 'hosts', 'network address', 'split', 'supernet', 'classification', 'rfc 5952'],
    load: () => import('../tools/subnet-calculator/subnet-calculator'),
  });
  r.add({
    id: 'vlsm-allocator', name: 'VLSM Allocator', category: 'network', status: 'available',
    summary: 'Divide an IPv4 network into right-sized subnets for named host counts, around fixed and reserved space.',
    keywords: ['vlsm', 'variable length', 'allocate', 'allocation', 'hosts', 'subnet plan', 'ipv4', 'cidr', 'addressing plan'],
    load: () => import('../tools/vlsm-allocator/vlsm-allocator'),
  });
  r.add({
    id: 'network-planner', name: 'NetForge Subnet & VLAN Planner', category: 'network', status: 'available',
    summary: 'Plan sites, VRFs and VLANs with gateways, DHCP pools and reservations: whole-plan validation, IPv4 and IPv6 allocation and an address map.',
    keywords: ['vlan', 'vlsm', 'ipam', 'dhcp', 'gateway', 'ipv6', 'subnet plan', 'allocation', 'overlap', 'vrf', 'site', 'routing domain', 'address map', 'namespace'],
    load: () => import('../tools/network-planner/network-planner'),
  });
  r.add({
    id: 'ip-range-analyzer', name: 'IP Range Analyzer', category: 'network', status: 'available',
    summary: 'Find duplicates, overlaps, containment and gaps in a list of networks and ranges, IPv4 and IPv6.',
    keywords: ['range', 'ip range', 'overlap', 'duplicate', 'gap', 'conflict', 'start', 'end', 'cidr', 'ipv4', 'ipv6', 'range to cidr'],
    load: () => import('../tools/ip-range-analyzer/ip-range-analyzer'),
  });
  r.add({
    id: 'route-summarization', name: 'Route Summarization', category: 'network', status: 'available',
    summary: 'Combine networks into the fewest exact routes, IPv4 and IPv6 kept apart.',
    keywords: ['summarize', 'summary', 'supernet', 'aggregate', 'aggregation', 'routes', 'prefix', 'collapse', 'cidr'],
    load: () => import('../tools/route-summarization/route-summarization'),
  });

  // Scheduling
  r.add({
    id: 'cron-explainer', name: 'Cron Explainer', category: 'scheduling', status: 'available',
    summary: 'Explain standard cron, Quartz and systemd calendar expressions field by field, with the next runs in any time zone and UTC.',
    keywords: ['cron', 'crontab', 'quartz', 'systemd', 'oncalendar', 'calendar', 'schedule', 'next run', 'dst', 'vixie', 'cronie'],
    load: () => import('../tools/cron-explainer/cron-explainer'),
  });
  r.add({
    id: 'schedule-builder', name: 'Schedule Builder', category: 'scheduling', status: 'available',
    summary: 'Build a schedule once and get cron, Quartz, systemd and Windows Task Scheduler versions, each marked exact, approximate or unsupported.',
    keywords: ['systemd', 'timer', 'oncalendar', 'task scheduler', 'schtasks', 'powershell', 'windows', 'cron', 'quartz', 'schedule'],
    load: () => import('../tools/schedule-builder/schedule-builder'),
  });
  r.add({
    id: 'timestamp-converter', name: 'Timestamp Converter', category: 'scheduling', status: 'available',
    summary: 'Convert Unix seconds, milliseconds and ISO 8601 dates, in UTC and any time zone.',
    keywords: ['unix', 'epoch', 'time', 'date', 'iso 8601', 'rfc 3339', 'utc', 'timezone', 'time zone', 'milliseconds', 'seconds', 'dst'],
    load: () => import('../tools/timestamp-converter/timestamp-converter'),
  });

  // Data
  r.add({
    id: 'json-formatter', name: 'JSON Formatter', category: 'data', status: 'available',
    summary: 'Validate, pretty-print and minify JSON without changing any value.',
    keywords: ['json', 'pretty', 'pretty print', 'beautify', 'minify', 'validate', 'validator', 'lint', 'format'],
    load: () => import('../tools/json-formatter/json-formatter'),
  });
  r.add({
    id: 'yaml-xml-tools', name: 'YAML/XML Tools', category: 'data', status: 'available',
    summary: 'Validate and format YAML and XML, and convert YAML to JSON, JSON to YAML and XML to JSON, saying what each conversion cannot carry over.',
    keywords: ['yaml', 'yml', 'xml', 'convert', 'validate', 'format', 'json to yaml', 'yaml to json', 'xml to json', 'pretty', 'minify', 'well-formed', 'namespace'],
    load: () => import('../tools/yaml-xml-tools/yaml-xml-tools'),
  });
  r.add({
    id: 'number-bases', name: 'Number Bases & Bytes', category: 'data', status: 'available',
    summary: 'Convert integers between binary, octal, decimal and hex at any bit width, signed or unsigned, with byte order and storage units.',
    keywords: ['hex', 'hexadecimal', 'binary', 'octal', 'decimal', 'bytes', 'kib', 'mib', 'units', 'base', 'radix', 'twos complement', 'signed', 'unsigned', 'endian', 'bits', 'bigint'],
    load: () => import('../tools/number-bases/number-bases'),
  });

  // Encoding
  r.add({
    id: 'base64-url-hex', name: 'Base64 / URL / Hex', category: 'encoding', status: 'available',
    summary: 'Convert between UTF-8 text, Base64, Base64URL, hex and URL percent-encoding, with byte counts and exact errors for malformed input.',
    keywords: ['base64', 'base64url', 'url', 'percent', 'encode', 'decode', 'hex', 'urlencode', 'utf-8', 'utf8', 'bytes', 'unicode', 'rfc 4648'],
    load: () => import('../tools/base64-url-hex/base64-url-hex'),
  });
  r.add({
    id: 'hash-hmac', name: 'Hash / HMAC', category: 'encoding', status: 'available',
    summary: 'SHA-256, SHA-384, SHA-512, legacy SHA-1 and MD5, and HMAC, for text or files, computed on this device.',
    keywords: ['hash', 'sha', 'sha256', 'sha-256', 'sha384', 'sha512', 'sha1', 'md5', 'hmac', 'digest', 'checksum', 'file hash', 'verify download'],
    load: () => import('../tools/hash-hmac/hash-hmac'),
  });
  r.add({
    id: 'jwt-decoder', name: 'JWT Decoder', category: 'encoding', status: 'available',
    summary: 'Decode a JSON Web Token, read its claims and expiry, and verify its signature with a key you supply. Nothing is sent or stored.',
    keywords: ['jwt', 'token', 'jws', 'claims', 'bearer', 'decode', 'verify', 'signature', 'hs256', 'rs256', 'es256', 'exp', 'oauth', 'openid'],
    load: () => import('../tools/jwt-decoder/jwt-decoder'),
  });

  // Text
  r.add({
    id: 'regex-tester', name: 'Regex Tester', category: 'text', status: 'available',
    summary: 'Test JavaScript regular expressions: highlighted matches, capture groups and a replacement preview, with a time limit that stops runaway patterns.',
    keywords: ['regex', 'regexp', 'regular expression', 'pattern', 'match', 'capture group', 'named group', 'replace', 'javascript', 'backtracking'],
    load: () => import('../tools/regex-tester/regex-tester'),
  });
  r.add({
    id: 'text-tools', name: 'List / Text Tools', category: 'text', status: 'available',
    summary: 'Sort, deduplicate, trim, number and compare lists of lines, with text statistics.',
    keywords: ['list', 'sort', 'dedupe', 'deduplicate', 'unique', 'lines', 'case', 'trim', 'compare', 'intersection', 'difference', 'union', 'prefix', 'suffix', 'line numbers', 'word count', 'statistics'],
    load: () => import('../tools/text-tools/text-tools'),
  });

  // Generators
  r.add({
    id: 'uuid-tokens', name: 'UUID / Random Tokens', category: 'generators', status: 'available',
    summary: 'Generate UUIDs (versions 4 and 7) and random hex or Base64URL tokens with the secure random generator built into the browser.',
    keywords: ['uuid', 'guid', 'uuidv4', 'uuidv7', 'random', 'token', 'secret', 'generate', 'api key', 'entropy', 'bulk'],
    load: () => import('../tools/uuid-tokens/uuid-tokens'),
  });
  r.add({
    id: 'chmod-calculator', name: 'chmod Calculator', category: 'generators', status: 'available',
    summary: 'Convert Unix permissions between symbolic and octal notation, with setuid, setgid, the sticky bit and chmod commands to copy.',
    keywords: ['chmod', 'permissions', 'unix', 'linux', 'octal', 'rwx', 'umask', 'setuid', 'setgid', 'sticky', 'mode', 'symbolic'],
    load: () => import('../tools/chmod-calculator/chmod-calculator'),
  });

  // Automation / DevOps
  r.add({
    id: 'powershell-generator', name: 'PowerShell Generator', category: 'automation', status: 'available',
    summary: 'Preview PowerShell for a network plan: Windows DHCP scopes, exclusions, reservations and options, a read-only plan report, and a scheduled task. Nothing is run.',
    keywords: ['powershell', 'ps1', 'script', 'windows', 'automation', 'dhcp', 'scope', 'reservation', 'exclusion', 'dhcpserver', 'scheduled task', 'export'],
    load: () => import('../tools/powershell-generator/powershell-generator'),
  });
  r.add({
    id: 'terraform-export', name: 'Terraform Export', category: 'automation', status: 'available',
    summary: 'Preview a network plan as provider-neutral JSON, Terraform variables, or AWS VPC and subnet resources, with every incompatibility listed.',
    keywords: ['terraform', 'hcl', 'iac', 'infrastructure as code', 'export', 'aws', 'vpc', 'subnet', 'tfvars', 'json', 'opentofu'],
    load: () => import('../tools/terraform-export/terraform-export'),
  });
  r.add({
    id: 'network-config-export', name: 'Cisco / Juniper Export', category: 'automation', status: 'available',
    summary: 'Preview Cisco IOS / IOS-XE and Juniper Junos configuration snippets for the VLANs, gateway interfaces and DHCP pools in a network plan.',
    keywords: ['cisco', 'ios', 'ios-xe', 'juniper', 'junos', 'vlan', 'svi', 'irb', 'switch', 'config', 'configuration', 'snippet', 'export', 'routing instance', 'vrf', 'dhcp pool'],
    load: () => import('../tools/network-config-export/network-config-export'),
  });

  return r;
}
