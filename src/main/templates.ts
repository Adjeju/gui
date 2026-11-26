import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { kitProjectCss, STYLE_KITS, type StyleKitId } from '../shared/style-kits'
import type { ProjectTemplate } from '../shared/types'

/**
 * The files a new project starts with: a small Vite, React and Tailwind app that runs as
 * soon as its packages are installed, so the preview shows something to point at and the
 * agent has a known setup to build on. Blank has none: the agent picks the stack.
 */
type Files = Record<string, string>

const PACKAGE_JSON = `${JSON.stringify(
  {
    private: true,
    type: 'module',
    scripts: { dev: 'vite', build: 'vite build', preview: 'vite preview' },
    dependencies: { react: '^19.3.0', 'react-dom': '^19.3.0' },
    devDependencies: {
      '@tailwindcss/vite': '^4.3.3',
      '@vitejs/plugin-react': '^6.1.2',
      tailwindcss: '^4.3.3',
      vite: '^8.3.3',
    },
  },
  null,
  2,
)}\n`

const VITE_CONFIG = `import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
})
`

const MAIN = `import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.jsx'
import './index.css'

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
`

const GITIGNORE = `node_modules
dist
.DS_Store
`

const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`)

const indexHtml = (name: string) => `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${escapeHtml(name)}</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.jsx"></script>
  </body>
</html>
`

const websiteApp = (name: string) => `const name = ${JSON.stringify(name)}

const features = [
  {
    title: 'Fast to start',
    text: 'Everything you need for a first version, ready the moment you open it.',
  },
  {
    title: 'Easy to change',
    text: 'Point at any part of the page in Gui and describe what you want instead.',
  },
  {
    title: 'Real code',
    text: 'React and Tailwind under the hood, ready to ship when you are.',
  },
]

export default function App() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="mx-auto flex max-w-5xl items-center justify-between px-6 py-5">
        <span className="font-semibold">{name}</span>
        <nav className="flex items-center gap-6 text-sm text-muted-foreground">
          <a href="#features" className="hover:text-foreground">
            Features
          </a>
          <a href="#contact" className="hover:text-foreground">
            Contact
          </a>
          <a
            href="#contact"
            className="rounded-md bg-primary px-4 py-2 font-medium text-primary-foreground hover:bg-primary/90"
          >
            Get started
          </a>
        </nav>
      </header>

      <main>
        <section className="mx-auto max-w-5xl px-6 pt-20 pb-24">
          <p className="text-sm font-medium text-primary">Introducing {name}</p>
          <h1 className="mt-3 max-w-2xl font-heading text-5xl font-semibold tracking-tight text-balance">
            A clear headline that says what you do
          </h1>
          <p className="mt-5 max-w-xl text-lg text-pretty text-muted-foreground">
            One or two sentences on who it's for and why it matters. Replace this with your own
            story.
          </p>
          <div className="mt-8 flex gap-3">
            <a
              href="#contact"
              className="rounded-md bg-primary px-5 py-3 font-medium text-primary-foreground hover:bg-primary/90"
            >
              Get started
            </a>
            <a
              href="#features"
              className="rounded-md px-5 py-3 font-medium text-foreground ring-1 ring-border hover:bg-muted"
            >
              Learn more
            </a>
          </div>
        </section>

        <section id="features" className="border-t border-border bg-muted">
          <div className="mx-auto grid max-w-5xl gap-6 px-6 py-20 sm:grid-cols-3">
            {features.map((feature) => (
              <div key={feature.title} className="rounded-xl bg-card p-6 text-card-foreground ring-1 ring-border">
                <h2 className="font-semibold">{feature.title}</h2>
                <p className="mt-2 text-sm text-muted-foreground">{feature.text}</p>
              </div>
            ))}
          </div>
        </section>

        <section id="contact" className="mx-auto max-w-5xl px-6 py-20">
          <h2 className="text-2xl font-semibold">Ready when you are</h2>
          <p className="mt-2 text-muted-foreground">Tell people how to reach you or sign up.</p>
        </section>
      </main>

      <footer className="border-t border-border">
        <p className="mx-auto max-w-5xl px-6 py-8 text-sm text-muted-foreground">
          © {new Date().getFullYear()} {name}
        </p>
      </footer>
    </div>
  )
}
`

const dashboardApp = (name: string) => `const name = ${JSON.stringify(name)}

const stats = [
  { label: 'Revenue', value: '$48,210', change: '+12%' },
  { label: 'Orders', value: '1,284', change: '+8%' },
  { label: 'Customers', value: '932', change: '+3%' },
  { label: 'Refunds', value: '14', change: '-2%' },
]

const weeks = [32, 45, 38, 52, 61, 48, 70, 66, 74, 81, 77, 90]

const orders = [
  { id: '#1042', customer: 'Ava Thompson', status: 'Paid', total: '$129.00' },
  { id: '#1041', customer: 'Noah Kim', status: 'Pending', total: '$64.50' },
  { id: '#1040', customer: 'Mia Patel', status: 'Paid', total: '$310.00' },
  { id: '#1039', customer: 'Leo Garcia', status: 'Refunded', total: '$42.00' },
]

const nav = ['Overview', 'Orders', 'Customers', 'Products', 'Settings']

export default function App() {
  return (
    <div className="flex min-h-screen bg-background text-foreground">
      <aside className="hidden w-56 shrink-0 border-r border-border bg-card p-4 text-card-foreground md:block">
        <p className="px-2 font-semibold">{name}</p>
        <nav className="mt-6 flex flex-col gap-1 text-sm">
          {nav.map((item, i) => (
            <a
              key={item}
              href="#"
              className={
                i === 0
                  ? 'rounded-md bg-secondary px-2 py-1.5 font-medium text-secondary-foreground'
                  : 'rounded-md px-2 py-1.5 text-muted-foreground hover:bg-muted'
              }
            >
              {item}
            </a>
          ))}
        </nav>
      </aside>

      <main className="flex-1 p-6 md:p-8">
        <h1 className="font-heading text-2xl font-semibold">Overview</h1>
        <p className="mt-1 text-sm text-muted-foreground">The last 12 weeks</p>

        <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {stats.map((stat) => (
            <div key={stat.label} className="rounded-xl bg-card p-4 text-card-foreground ring-1 ring-border">
              <p className="text-sm text-muted-foreground">{stat.label}</p>
              <p className="mt-1 text-2xl font-semibold tabular-nums">{stat.value}</p>
              <p
                className={
                  stat.change.startsWith('-')
                    ? 'mt-1 text-sm text-rose-600'
                    : 'mt-1 text-sm text-emerald-600'
                }
              >
                {stat.change}
              </p>
            </div>
          ))}
        </div>

        <section className="mt-6 rounded-xl bg-card p-4 text-card-foreground ring-1 ring-border">
          <h2 className="font-medium">Revenue by week</h2>
          <div className="mt-4 flex h-40 items-end gap-2">
            {weeks.map((value, i) => (
              <div
                key={i}
                className="flex-1 rounded-t bg-primary"
                style={{ height: \`\${value}%\` }}
              />
            ))}
          </div>
        </section>

        <section className="mt-6 overflow-hidden rounded-xl bg-card text-card-foreground ring-1 ring-border">
          <h2 className="p-4 font-medium">Recent orders</h2>
          <table className="w-full text-left text-sm">
            <thead className="border-y border-border bg-muted text-foreground">
              <tr>
                <th className="px-4 py-2 font-medium">Order</th>
                <th className="px-4 py-2 font-medium">Customer</th>
                <th className="px-4 py-2 font-medium">Status</th>
                <th className="px-4 py-2 text-right font-medium">Total</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {orders.map((order) => (
                <tr key={order.id}>
                  <td className="px-4 py-2 font-medium">{order.id}</td>
                  <td className="px-4 py-2">{order.customer}</td>
                  <td className="px-4 py-2 text-muted-foreground">{order.status}</td>
                  <td className="px-4 py-2 text-right tabular-nums">{order.total}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      </main>
    </div>
  )
}
`

function templateFiles(template: ProjectTemplate, name: string, kit: StyleKitId): Files {
  if (template === 'blank') return {}
  return {
    '.gitignore': GITIGNORE,
    'package.json': PACKAGE_JSON,
    'vite.config.js': VITE_CONFIG,
    'index.html': indexHtml(name),
    'src/main.jsx': MAIN,
    'src/index.css': kitProjectCss(STYLE_KITS.find((k) => k.id === kit) ?? STYLE_KITS[0]),
    'src/App.jsx': template === 'website' ? websiteApp(name) : dashboardApp(name),
  }
}

/** Writes `template`'s files into the new project at `root`, named `name` in the page, styled by `kit`. */
export async function writeTemplate(
  root: string,
  template: ProjectTemplate,
  name: string,
  kit: StyleKitId = 'neutral',
) {
  for (const [path, text] of Object.entries(templateFiles(template, name, kit))) {
    const file = join(root, path)
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, text, { flag: 'wx' })
  }
}
