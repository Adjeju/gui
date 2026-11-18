import { expect, test } from '@playwright/test'

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

test.describe('on Linux', () => {
  test.use({
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/142.0 Safari/537.36',
  })

  test('the home page offers the Linux download, without the Mac steps', async ({ page }) => {
    // The worker answers /download with the Linux page; here it only has to be asked.
    await page.route('**/download', (route) => route.fulfill({ status: 204 }))
    await page.goto('/')
    const download = page.getByRole('link', { name: 'Download for Linux', exact: true })
    await expect(download).toHaveAttribute('href', '/download')
    await download.click()
    await expect(page.locator('[data-download-help]')).toBeHidden()
  })
})
