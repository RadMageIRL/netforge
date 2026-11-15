// Runs the Terraform CLI over NetForge's generated Terraform and writes
// tests/fixtures/terraform-validate.json.
//
//   NETFORGE_WRITE_TF_CASES=<cases.json> npx vitest run tests/unit/export-terraform-validate.test.ts
//   node scripts/oracles/terraform_validate.mjs <cases.json> tests/fixtures/terraform-validate.json
//
// Needs the Terraform CLI at local/tools/terraform/terraform.exe (or the path in
// NETFORGE_TERRAFORM) and network access once, for "terraform init" to download hashicorp/aws
// into an isolated plugin cache under local/tools/tf-work/. Nothing in the user profile is read
// or written: the CLI configuration file, plugin cache, data directories and AWS configuration
// paths all point inside local/tools/tf-work/.
//
// What runs, per case: terraform validate, terraform plan (saved to a file) and terraform show
// -json on that file. "terraform apply" and "terraform destroy" are never run. The AWS cases plan
// with placeholder credentials and every provider lookup turned off, so the plan contacts nothing;
// those settings live in a test-only file next to the generated one and are not NetForge output.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const [casesPath, outPath] = process.argv.slice(2);
if (!casesPath || !outPath) {
  console.error('usage: node scripts/oracles/terraform_validate.mjs <cases.json> <fixture.json>');
  process.exit(2);
}
const TF = process.env.NETFORGE_TERRAFORM ?? join(ROOT, 'local', 'tools', 'terraform', 'terraform.exe');
if (!existsSync(TF)) {
  console.error(`Terraform CLI not found at ${TF}`);
  process.exit(2);
}
const WORK = join(ROOT, 'local', 'tools', 'tf-work');
const CACHE = join(WORK, 'plugin-cache');
const RC = join(WORK, 'terraform.rc');
mkdirSync(CACHE, { recursive: true });
writeFileSync(RC, `plugin_cache_dir = "${CACHE.replaceAll('\\', '/')}"\ndisable_checkpoint = true\n`);

function environment(dataDir) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!/^(AWS_|TF_)/i.test(k)) env[k] = v;
  return {
    ...env,
    TF_CLI_CONFIG_FILE: RC, TF_DATA_DIR: dataDir, TF_IN_AUTOMATION: '1', TF_INPUT: '0', CHECKPOINT_DISABLE: '1',
    AWS_CONFIG_FILE: join(WORK, 'no-aws-config'), AWS_SHARED_CREDENTIALS_FILE: join(WORK, 'no-aws-credentials'), AWS_EC2_METADATA_DISABLED: 'true',
  };
}

function tf(cwd, dataDir, args, input) {
  const r = spawnSync(TF, args, { cwd, env: environment(dataDir), encoding: 'utf8', input, maxBuffer: 256 * 1024 * 1024 });
  return { code: r.status, out: r.stdout ?? '', err: r.stderr ?? '' };
}

const TEST_PROVIDER = `# Test-only settings so "terraform plan" runs without an AWS account. Not NetForge output.
provider "aws" {
  region                      = "us-east-1"
  access_key                  = "netforge-placeholder"
  secret_key                  = "netforge-placeholder"
  skip_credentials_validation = true
  skip_requesting_account_id  = true
  skip_metadata_api_check     = true
  skip_region_validation      = true
}
`;
const ZONES = ['us-east-1a', 'us-east-1b', 'us-east-1c', 'us-east-1d', 'us-east-1e', 'us-east-1f'];
const POOL = 'ipv6pool-ec2-0123456789abcdef0';

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])]));
  return value;
}
const same = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
const show = v => JSON.stringify(v).slice(0, 160);

const doc = JSON.parse(readFileSync(casesPath, 'utf8'));
const DATA = { aws: join(WORK, 'data-aws'), variables: join(WORK, 'data-plain') };
const LOCK = {};
const CASES = join(WORK, 'cases');
rmSync(CASES, { recursive: true, force: true });
let providerVersion = '';
const results = [];

function prepare(c, zonesFor) {
  const dir = join(CASES, c.id);
  mkdirSync(dir, { recursive: true });
  for (const f of c.files) writeFileSync(join(dir, f.name), f.text, 'utf8');
  if (c.kind === 'aws') {
    writeFileSync(join(dir, 'zz_test_provider.tf'), TEST_PROVIDER);
    const zones = Object.fromEntries(c.expected.subnets.map((s, i) => [s.name, ZONES[i % ZONES.length]]));
    const vars = { netforge_availability_zones: zonesFor ? zonesFor(zones) : zones };
    if (c.expected.assoc) vars.netforge_ipv6_pool = POOL;
    writeFileSync(join(dir, 'terraform.tfvars.json'), JSON.stringify(vars));
  } else {
    const names = Object.keys(c.expected);
    writeFileSync(join(dir, 'zz_test_outputs.tf'), `# Test-only: shows the values Terraform read. Not NetForge output.\noutput "all" {\n  value = {\n${names.map(n => `    ${n} = var.${n}`).join('\n')}\n  }\n}\n`);
  }
  // One "terraform init" per kind; the lock file it writes is reused by the other cases.
  if (!LOCK[c.kind]) {
    const init = tf(dir, DATA[c.kind], ['init', '-input=false', '-no-color']);
    if (init.code !== 0) throw new Error(`terraform init failed for ${c.id}:\n${init.out}\n${init.err}`);
    const lock = join(dir, '.terraform.lock.hcl');
    LOCK[c.kind] = existsSync(lock) ? readFileSync(lock, 'utf8') : '';
    if (c.kind === 'aws') providerVersion = /version\s*=\s*"([^"]+)"/.exec(LOCK.aws)?.[1] ?? '';
  } else if (LOCK[c.kind] !== '') writeFileSync(join(dir, '.terraform.lock.hcl'), LOCK[c.kind]);
  return dir;
}

function checkAws(c, plan, problems) {
  const e = c.expected;
  const planned = new Map((plan.planned_values?.root_module?.resources ?? []).map(r => [r.address, r.values]));
  const config = new Map((plan.configuration?.root_module?.resources ?? []).map(r => [r.address, r]));
  const vpc = `aws_vpc.${e.vpc.name}`;
  const assoc = e.assoc ? `aws_vpc_ipv6_cidr_block_association.${e.assoc.name}` : null;
  const want = [vpc, ...(assoc ? [assoc] : []), ...e.subnets.map(s => `aws_subnet.${s.name}`)].sort();
  if (!same([...planned.keys()].sort(), want)) problems.push(`planned resources ${show([...planned.keys()].sort())} != ${show(want)}`);
  const actions = new Set((plan.resource_changes ?? []).flatMap(r => r.change.actions));
  if (!same([...actions], ['create'])) problems.push(`planned actions ${show([...actions])}`);
  const tags = v => v ?? {};
  const pv = planned.get(vpc);
  if (pv?.cidr_block !== e.vpc.cidr) problems.push(`vpc cidr ${show(pv?.cidr_block)}`);
  if (!same(tags(pv?.tags), e.vpc.tags)) problems.push(`vpc tags ${show(pv?.tags)} != ${show(e.vpc.tags)}`);
  if (assoc) {
    const av = planned.get(assoc);
    if (av?.ipv6_cidr_block !== e.assoc.cidr || av?.ipv6_pool !== POOL) problems.push(`association ${show(av)}`);
    if (!config.get(assoc)?.expressions?.vpc_id?.references?.includes(`${vpc}.id`)) problems.push('association vpc_id does not refer to the VPC');
  }
  e.subnets.forEach((s, i) => {
    const address = `aws_subnet.${s.name}`;
    const v = planned.get(address);
    const cfg = config.get(address);
    if (v?.cidr_block !== s.cidr) problems.push(`${address} cidr ${show(v?.cidr_block)}`);
    if (v?.availability_zone !== ZONES[i % ZONES.length]) problems.push(`${address} zone ${show(v?.availability_zone)}`);
    if ((v?.ipv6_cidr_block ?? null) !== s.ipv6) problems.push(`${address} ipv6 ${show(v?.ipv6_cidr_block)} != ${show(s.ipv6)}`);
    if (!same(tags(v?.tags), s.tags)) problems.push(`${address} tags ${show(v?.tags)} != ${show(s.tags)}`);
    if (!cfg?.expressions?.vpc_id?.references?.includes(`${vpc}.id`)) problems.push(`${address} vpc_id does not refer to the VPC`);
    if (!cfg?.expressions?.availability_zone?.references?.includes('var.netforge_availability_zones')) problems.push(`${address} zone does not come from the variable`);
    if (!same(cfg?.depends_on ?? [], s.ipv6 ? [assoc] : [])) problems.push(`${address} depends_on ${show(cfg?.depends_on)}`);
  });
  const provider = plan.configuration?.provider_config?.aws;
  if (provider?.full_name !== 'registry.terraform.io/hashicorp/aws' || provider?.version_constraint !== e.provider) problems.push(`provider ${show(provider)}`);
  const variables = Object.keys(plan.configuration?.root_module?.variables ?? {}).sort();
  if (!same(variables, ['netforge_availability_zones', ...(assoc ? ['netforge_ipv6_pool'] : [])])) problems.push(`variables ${show(variables)}`);
  for (const [name, v] of Object.entries(plan.configuration?.root_module?.variables ?? {})) if ('default' in v) problems.push(`variable ${name} has a default`);
}

function checkVariables(c, plan, problems) {
  const value = plan.planned_values?.outputs?.all?.value;
  for (const [name, expected] of Object.entries(c.expected)) {
    if (!same(value?.[name], expected)) {
      const got = value?.[name] ?? {};
      const keys = Object.keys(expected).filter(k => !same(got[k], expected[k]));
      problems.push(`${name} differs at ${show(keys.slice(0, 5))}: ${show(got[keys[0]])} != ${show(expected[keys[0]])}`);
    }
  }
}

for (const c of doc.cases) {
  const dir = prepare(c);
  const problems = [];
  const validate = tf(dir, DATA[c.kind], ['validate', '-json']);
  let valid = false;
  try {
    const v = JSON.parse(validate.out);
    valid = v.valid === true && v.error_count === 0 && v.warning_count === 0;
    if (!valid) problems.push(...v.diagnostics.map(d => `validate: ${d.severity}: ${d.summary}: ${d.detail ?? ''}`.slice(0, 300)));
  } catch {
    problems.push(`validate printed no JSON: ${validate.err.slice(0, 300)}`);
  }
  const planRun = tf(dir, DATA[c.kind], ['plan', '-input=false', '-lock=false', '-refresh=false', '-no-color', '-out=plan.bin']);
  const planned = planRun.code === 0;
  if (!planned) problems.push(`plan failed: ${planRun.err.slice(0, 400)}`);
  let matches = false;
  if (planned) {
    const shown = tf(dir, DATA[c.kind], ['show', '-json', 'plan.bin']);
    const before = problems.length;
    try {
      const plan = JSON.parse(shown.out);
      if (c.kind === 'aws') checkAws(c, plan, problems);
      else checkVariables(c, plan, problems);
      matches = problems.length === before;
    } catch (error) {
      problems.push(`show -json: ${String(error).slice(0, 200)}`);
    }
  }
  const hclFiles = c.files.filter(f => !f.name.endsWith('.json')).map(f => f.name);
  const fmt = tf(dir, DATA[c.kind], ['fmt', '-check', '-list=false', ...hclFiles]);
  results.push({ id: c.id, kind: c.kind, hash: c.hash, validate: valid, plan: planned, matches, problems, canonicalFormat: fmt.code === 0 });
  console.log(`${problems.length === 0 ? 'ok  ' : 'FAIL'} ${c.id}${problems.length ? `\n     ${problems.join('\n     ')}` : ''}`);
}

// A subnet whose Availability Zone key is missing must fail at plan time, not get a guessed zone.
const first = doc.cases.find(c => c.kind === 'aws');
const missingDir = prepare({ ...first, id: 'zz-missing-zone-key' }, zones => Object.fromEntries(Object.entries(zones).slice(1)));
const missing = tf(missingDir, DATA.aws, ['plan', '-input=false', '-lock=false', '-refresh=false', '-no-color']);
const missingSummary = /Error: ([^\r\n]+)/.exec(missing.err)?.[1] ?? '';
console.log(`missing zone key: exit ${missing.code}, ${missingSummary}`);

const version = JSON.parse(tf(WORK, DATA.variables, ['version', '-json']).out).terraform_version;
writeFileSync(outPath, `${JSON.stringify({
  note: 'Made by scripts/oracles/terraform_validate.mjs. terraform validate, plan and show -json ran for every case; terraform apply never ran. AWS cases planned with placeholder credentials and contacted nothing.',
  terraform: version,
  provider: { source: 'registry.terraform.io/hashicorp/aws', version: providerVersion, constraint: first.expected.provider },
  applied: false,
  missingZoneKey: { planFailed: missing.code !== 0, summary: missingSummary },
  cases: results,
}, null, 1)}\n`);
const failed = results.filter(r => r.problems.length > 0).length;
console.log(`${results.length - failed} of ${results.length} cases pass; ${results.filter(r => r.canonicalFormat).length} are in canonical "terraform fmt" form. Terraform ${version}, hashicorp/aws ${providerVersion}.`);
process.exit(failed === 0 && missing.code !== 0 ? 0 : 1);
