import { expect, type Page, test } from '@playwright/test'

// On Linux, /download is the download page for the browser's processor (worker.js): the install
// command first, then the AppImage and the .deb, and a link to the other processor's page.

for (const [path, arch, deb, other] of [
  ['/download/linux', 'x86_64', 'amd64', '/download/linux-arm64'],
  ['/download/linux-arm64', 'arm64', 'arm64', '/download/linux'],
] as const) {
  test(`${path} offers the install command, then the ${arch} AppImage and the .deb`, async ({
    page,
  }) => {
    await page.goto(path)
    await expect(page).toHaveTitle('Gui for Linux — Gui')
    await expect(page.getByRole('heading', { level: 1, name: 'Gui for Linux' })).toBeVisible()
    await expect(page.locator('pre')).toHaveText('curl -fsSL https://usegui.com/install.sh | sh')
    await expect(page.getByRole('link', { name: 'AppImage', exact: true })).toHaveAttribute(
      'href',
      `/download/Gui-${arch}.AppImage`,
    )
    await expect(page.locator('p code')).toHaveText(
      `chmod +x Gui-${arch}.AppImage && ./Gui-${arch}.AppImage`,
    )
    await expect(page.getByRole('link', { name: '.deb package' })).toHaveAttribute(
      'href',
      `/download/Gui-${deb}.deb`,
    )
    await expect(page.getByRole('link', { name: /^Download Gui for / })).toHaveAttribute(
      'href',
      other,
    )
  })
}

/**
 * Clicks the home page's download button but keeps the page, so the test sees what the click
 * itself did. The real /download is another page (Linux) or a file (Mac). A route that answers
 * the navigation with 204 does not work: Playwright then waits for a navigation that never ends.
 */
async function clickDownload(page: Page, name: string) {
  await page.goto('/')
  const download = page.getByRole('link', { name, exact: true })
  await expect(download).toHaveAttribute('href', '/download')
  // Runs after the page's own click handler on the button, and only stops the navigation.
  await page.evaluate(() => addEventListener('click', (event) => event.preventDefault()))
  await download.click()
}

test.describe('on Linux', () => {
  test.use({
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/142.0 Safari/537.36',
  })

  test('the home page offers the Linux download, without the Mac steps', async ({ page }) => {
    // The worker answers /download with the Linux page, which has its own steps.
    await clickDownload(page, 'Download for Linux')
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(page.locator('[data-download-help]')).toBeHidden()
  })
})

test.describe('on a Mac', () => {
  test.use({
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/142.0 Safari/537.36',
  })

  test('the home page downloads for Mac and shows the Mac steps', async ({ page }) => {
    await clickDownload(page, 'Download for Mac')
    await expect(page.locator('[data-download-help]')).toBeVisible()
    await expect(page.locator('[data-download-help]')).toContainText('open Gui.dmg')
  })
})
