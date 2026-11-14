import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { grantClipboard, openTool, readClipboard, resultValue, watchErrors } from './helpers';

const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'];

async function axe(page: Page): Promise<string[]> {
  const results = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  return results.violations.map(v => `${v.id}: ${v.help} (${v.nodes.map(n => n.target.join(' ')).join(', ')})`);
}

test.beforeEach(async ({ page }) => {
  await openTool(page, 'chmod-calculator', 'chmod Calculator');
});

test('starts at 644 and keeps check boxes, octal and string in step', async ({ page }) => {
  const errors = watchErrors(page);
  await expect(page.locator('#chmod-octal')).toHaveValue('644');
  await expect(page.locator('#chmod-ls')).toHaveValue('rw-r--r--');
  await expect(page.locator('#perm-u-w')).toBeChecked();
  await expect(page.locator('#perm-g-w')).not.toBeChecked();
  await expect(resultValue(page, 'command-octal')).toHaveText('chmod 0644 <PATH>');
  await expect(resultValue(page, 'command-symbolic')).toHaveText('chmod u=rw,g=r,o=r <PATH>');

  await page.locator('#perm-u-x').check();
  await page.locator('#perm-g-x').check();
  await page.locator('#perm-o-x').check();
  await expect(page.locator('#chmod-octal')).toHaveValue('755');
  await expect(page.locator('#chmod-ls')).toHaveValue('rwxr-xr-x');
  await expect(resultValue(page, 'symbolic')).toHaveText('u=rwx,g=rx,o=rx');

  await page.fill('#chmod-octal', '2770');
  await expect(page.locator('#perm-sgid')).toBeChecked();
  await expect(page.locator('#perm-o-r')).not.toBeChecked();
  await expect(page.locator('#chmod-ls')).toHaveValue('rwxrws---');
  await expect(page.locator('#chmod-octal')).toHaveValue('2770');

  await page.fill('#chmod-ls', 'drwxrwxrwt');
  await expect(page.locator('#chmod-octal')).toHaveValue('1777');
  await expect(page.locator('#perm-sticky')).toBeChecked();
  await expect(page.getByRole('radio', { name: 'Directory' })).toBeChecked();
  await expect(resultValue(page, 'ls')).toHaveText('drwxrwxrwt');
  await expect(page.locator('#chmod-status')).toContainText('1777 drwxrwxrwt');

  await page.getByRole('button', { name: '600', exact: true }).click();
  await expect(page.locator('#chmod-ls')).toHaveValue('rw-------');
  expect(errors).toEqual([]);
});

test('shows field errors without changing the mode', async ({ page }) => {
  await page.fill('#chmod-octal', '79');
  await expect(page.locator('#chmod-octal-error')).toContainText('"9" is not an octal digit');
  await expect(page.locator('#chmod-ls')).toHaveValue('rw-r--r--');
  await page.fill('#chmod-octal', '75');
  await expect(page.locator('#chmod-octal-error')).toContainText('Enter 3 digits');
  await page.fill('#chmod-octal', '750');
  await expect(page.locator('#chmod-octal-error')).toBeHidden();
  await page.fill('#chmod-ls', 'rwxr-xr-q');
  await expect(page.locator('#chmod-ls-error')).toContainText('Character 9 is "q"');
  await expect(page.locator('#chmod-octal')).toHaveValue('750');
});

test('quotes the path safely in the commands and copies them', async ({ page, context }) => {
  await grantClipboard(context);
  await page.fill('#chmod-path', "/srv/John's files/$(reboot)");
  await expect(resultValue(page, 'command-octal')).toHaveText("chmod 0644 '/srv/John'\\''s files/$(reboot)'");
  await page.locator('tr[data-key="command-octal"] button').click();
  expect(await readClipboard(page)).toBe("chmod 0644 '/srv/John'\\''s files/$(reboot)'");
  await page.fill('#chmod-path', '-rf');
  await expect(resultValue(page, 'command-symbolic')).toHaveText('chmod u=rw,g=r,o=r -- -rf');
  await page.fill('#chmod-path', '/var/www');
  await expect(resultValue(page, 'command-octal')).toHaveText('chmod 0644 /var/www');
  await page.locator('#chmod-path').evaluate((el: HTMLInputElement) => { el.value = 'a\tb'; el.dispatchEvent(new Event('input', { bubbles: true })); });
  await expect(page.locator('#chmod-path-error')).toContainText('control character');
  await expect(page.locator('tr[data-key="command-octal"]')).toHaveCount(0);
});

test('explains bits for files and directories and warns about risky modes', async ({ page }) => {
  await expect(page.locator('#chmod-warnings .notice')).toHaveCount(0);
  await expect(page.locator('#chmod-meaning')).toContainText('The owner can change the file.');
  await page.fill('#chmod-octal', '777');
  await expect(page.locator('#chmod-warnings')).toContainText('Mode 777 lets every account on the system read, change and run the file.');
  await page.getByRole('radio', { name: 'Directory' }).check();
  await expect(page.locator('#chmod-warnings')).toContainText('list, create and delete entries');
  await expect(page.locator('#chmod-meaning')).toContainText('enter the directory');
  await expect(resultValue(page, 'ls')).toHaveText('drwxrwxrwx');
  await expect(page.locator('#chmod-dir-note')).toContainText('GNU chmod keeps setuid and setgid');
  await expect(resultValue(page, 'command-symbolic')).toHaveText('chmod u=rwx,g=rwx,o=rwx,ug-s <PATH>');
  await page.locator('#perm-sticky').check();
  await expect(page.locator('#chmod-warnings .notice')).toHaveCount(0);
  await expect(page.locator('#chmod-meaning')).toContainText('as in /tmp');
  await expect(page.locator('#chmod-ntfs-note')).toContainText('NetForge does not convert between them');
});

test('previews symbolic and numeric changes as GNU chmod applies them', async ({ page }) => {
  await expect(page.locator('#chmod-use')).toBeDisabled();
  await page.fill('#chmod-expr', 'u+x,go-r');
  await expect(page.locator('#chmod-expr-result')).toContainText('changes 0644 rw-r--r-- to 0700 rwx------ on a file');
  await page.fill('#chmod-expr', '+w');
  await expect(page.locator('#chmod-expr-result')).toContainText('(no change)');
  await page.fill('#chmod-umask', '002');
  await expect(page.locator('#chmod-expr-result')).toContainText('to 0664 rw-rw-r--');
  await page.fill('#chmod-umask', '9');
  await expect(page.locator('#chmod-umask-error')).toContainText('1 to 4 octal digits');
  await page.fill('#chmod-umask', '022');
  await page.fill('#chmod-expr', 'a+X');
  await expect(page.locator('#chmod-expr-result')).toContainText('(no change)');
  await page.getByRole('radio', { name: 'Directory' }).check();
  await expect(page.locator('#chmod-expr-result')).toContainText('to 0755 rwxr-xr-x on a directory');
  await page.fill('#chmod-expr', 'u+q');
  await expect(page.locator('#chmod-expr-error')).toContainText('"q" is not expected here');
  await page.fill('#chmod-expr', 'g+s');
  await page.locator('#chmod-use').click();
  await expect(page.locator('#chmod-octal')).toHaveValue('2644');
  await page.fill('#chmod-expr', '');
  await page.fill('#chmod-numeric', '755');
  await expect(page.locator('#chmod-numeric-result')).toContainText('leaves 2755 rwxr-sr-x on a directory. GNU chmod kept setuid or setgid');
  await page.fill('#chmod-numeric', '00755');
  await expect(page.locator('#chmod-numeric-result')).toContainText('leaves 0755 rwxr-xr-x on a directory.');
  await expect(page.locator('#chmod-numeric-result')).not.toContainText('kept');
});

test('is accessible, works from the keyboard and fits a phone-width screen', async ({ page }) => {
  expect(await axe(page)).toEqual([]);
  await page.locator('#perm-u-r').focus();
  await page.keyboard.press('Space');
  await expect(page.locator('#chmod-octal')).toHaveValue('244');
  await expect(page.locator('#chmod-warnings')).toContainText('owner has no read permission');
  await page.fill('#chmod-octal', '4777');
  await page.fill('#chmod-expr', 'bad');
  await page.fill('#chmod-path', '/a/very/long/path/' + 'segment/'.repeat(30));
  expect(await axe(page)).toEqual([]);
  await page.setViewportSize({ width: 390, height: 844 });
  const { scroll, client } = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
  expect(scroll).toBeLessThanOrEqual(client);
  expect(await axe(page)).toEqual([]);
});

test('stores nothing', async ({ page }) => {
  await page.fill('#chmod-path', '/secret/place');
  await page.fill('#chmod-octal', '4711');
  const stored = await page.evaluate(() => JSON.stringify([{ ...localStorage }, { ...sessionStorage }, document.cookie]));
  expect(stored).not.toContain('secret');
  expect(stored).not.toContain('4711');
  await page.reload();
  await expect(page.locator('#chmod-path')).toHaveValue('');
  await expect(page.locator('#chmod-octal')).toHaveValue('644');
});
