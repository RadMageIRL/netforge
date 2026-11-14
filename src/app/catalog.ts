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
    id: 'network-planner', name: 'NetForge Subnet & VLAN Planner', category: 'network', status: 'planned',
    summary: 'Plan VLANs, subnets, gateways and DHCP ranges, with VLSM allocation and conflict checks.',
    keywords: ['vlan', 'vlsm', 'ipam', 'dhcp', 'gateway', 'ipv6', 'subnet plan', 'allocation', 'overlap'],
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
    id: 'cron-explainer', name: 'Cron Explainer', category: 'scheduling', status: 'planned',
    summary: 'Explain a cron expression in plain English and list its next run times.',
    keywords: ['cron', 'crontab', 'quartz', 'schedule', 'next run'],
  });
  r.add({
    id: 'schedule-builder', name: 'Schedule Builder', category: 'scheduling', status: 'planned',
    summary: 'Build schedules for cron, systemd timers and Windows Task Scheduler.',
    keywords: ['systemd', 'timer', 'oncalendar', 'task scheduler', 'schtasks', 'windows', 'cron'],
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
    id: 'yaml-xml-tools', name: 'YAML/XML Tools', category: 'data', status: 'planned',
    summary: 'Validate and convert YAML and XML.',
    keywords: ['yaml', 'yml', 'xml', 'convert', 'validate'],
  });
  r.add({
    id: 'number-bases', name: 'Number Bases & Bytes', category: 'data', status: 'planned',
    summary: 'Convert between decimal, hex, binary and octal, and between byte units.',
    keywords: ['hex', 'hexadecimal', 'binary', 'octal', 'decimal', 'bytes', 'kib', 'mib', 'units', 'base'],
  });

  // Encoding
  r.add({
    id: 'base64-url-hex', name: 'Base64 / URL / Hex', category: 'encoding', status: 'planned',
    summary: 'Encode and decode Base64, URL percent-encoding and hex.',
    keywords: ['base64', 'url', 'percent', 'encode', 'decode', 'hex', 'urlencode'],
  });
  r.add({
    id: 'hash-hmac', name: 'Hash / HMAC', category: 'encoding', status: 'planned',
    summary: 'SHA digests and HMACs computed with the browser\'s Web Crypto API.',
    keywords: ['hash', 'sha', 'sha256', 'sha512', 'hmac', 'digest', 'checksum'],
  });
  r.add({
    id: 'jwt-decoder', name: 'JWT Decoder', category: 'encoding', status: 'planned',
    summary: 'Decode a JSON Web Token\'s header and claims.',
    keywords: ['jwt', 'token', 'jws', 'claims', 'bearer', 'decode'],
  });

  // Text
  r.add({
    id: 'regex-tester', name: 'Regex Tester', category: 'text', status: 'planned',
    summary: 'Test regular expressions against sample text and see every match.',
    keywords: ['regex', 'regexp', 'regular expression', 'pattern', 'match'],
  });
  r.add({
    id: 'text-tools', name: 'List / Text Tools', category: 'text', status: 'planned',
    summary: 'Sort, deduplicate, trim and change the case of lines of text.',
    keywords: ['list', 'sort', 'dedupe', 'deduplicate', 'unique', 'lines', 'case', 'trim'],
  });

  // Generators
  r.add({
    id: 'uuid-tokens', name: 'UUID / Random Tokens', category: 'generators', status: 'planned',
    summary: 'Generate UUIDs and random tokens with the browser\'s secure random generator.',
    keywords: ['uuid', 'guid', 'random', 'token', 'secret', 'generate'],
  });
  r.add({
    id: 'chmod-calculator', name: 'chmod Calculator', category: 'generators', status: 'planned',
    summary: 'Convert Unix permissions between symbolic and octal notation.',
    keywords: ['chmod', 'permissions', 'unix', 'linux', 'octal', 'rwx', 'umask'],
  });

  // Automation / DevOps
  r.add({
    id: 'powershell-generator', name: 'PowerShell Generator', category: 'automation', status: 'planned',
    summary: 'Generate PowerShell from NetForge plans and schedules, as a reviewed preview.',
    keywords: ['powershell', 'ps1', 'script', 'windows', 'automation'],
  });
  r.add({
    id: 'terraform-export', name: 'Terraform Export', category: 'automation', status: 'planned',
    summary: 'Export NetForge plans as Terraform, as a reviewed preview.',
    keywords: ['terraform', 'hcl', 'iac', 'infrastructure as code', 'export'],
  });

  return r;
}
