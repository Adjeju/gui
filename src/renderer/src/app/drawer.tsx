import {
  lazy,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
  Suspense,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import { flushSync } from 'react-dom'
import { DRAWER_HEIGHT, drawerHeight } from '../../../shared/layout'
import {
  type AgentId,
  type DrawerTab,
  drawerNeighbor,
  type TerminalId,
  type WindowState,
} from '../../../shared/types'
import { gui } from '../lib/api'
import { cn } from '../lib/cn'
import { ChevronDown, Info, Plus, SquareTerminal, TriangleAlert } from '../lib/icons'
import { trackDrag } from '../lib/pointer-drag'
import { StatusDot } from '../lib/status'
import { Banner, PanelHeader } from '../lib/surface'
import {
  rovingTabKeyDown,
  SCROLLING_TABLIST,
  TAB_LABEL,
  TabCloseButton,
  tabClass,
  useScrollingTabs,
} from '../lib/tabs'
import { Button, IconButton, PRESS, TIGHT_HIT_AREA } from '../lib/ui'
import { FIND_EVENT } from './find-bar'
import { FixStartupButton } from './fix-startup'
import { useLayoutSlide } from './layout-morph'
import { crashed, serverStatus, stoppedOutside } from './server-status'

// Ghostty (WebAssembly) is most of the main window's code; it loads after the window's first
// paint.
const terminalViews = () => import('./terminal-views')
const LogsView = lazy(() => terminalViews().then((m) => ({ default: m.LogsView })))
const ShellView = lazy(() => terminalViews().then((m) => ({ default: m.ShellView })))

const tabId = (tab: DrawerTab) => `drawer-tab-${tab}`
const panelId = (tab: DrawerTab) => `drawer-panel-${tab}`

interface TabEntry {
  tab: DrawerTab
  label: string
  icon: ReactNode
  /** Read after the label, for assistive tech */
  note?: string
  /** Errors in its output, as a small count after the label */
  errors?: number
}

/**
 * The drawer under the canvas (⌘J): the dev server's output, read-only, and the project's
 * terminals, each the user's own login shell at the project root, started when they open it.
 * "Show logs" wherever something went wrong opens it on the dev server's output. Closed,
 * nothing shows here unless the dev server crashed under a live preview, which gets a slim
 * bar instead of raw output. (With no preview to show, the canvas says so itself.)
 */
export function Drawer({ state }: { state: WindowState }) {
  // A tab that should take the keyboard once it shows: asked by main (⌘J, a new terminal) or
  // by a click on its tab here.
  const [focusRequest, setFocusRequest] = useState<DrawerTab | null>(null)
  useEffect(() => gui.onDrawerFocus(setFocusRequest), [])
  // Edit → Find while a terminal has the keyboard: to that terminal's find bar.
  useEffect(
    () =>
      gui.onFind(({ action, area }) => {
        if (area !== 'terminal') return
        const scope = document.activeElement?.closest('[data-find-scope="terminal"]')
        scope?.dispatchEvent(new CustomEvent(FIND_EVENT, { detail: action }))
      }),
    [],
  )
  // Focus mode hides it, with the rest of the chrome.
  const open = state.drawer.open && !state.focusMode && state.project !== null
  const section = useRef<HTMLElement>(null)
  // Hidden with the keyboard in it (⌘J, the chevron), it goes to the preview, not nowhere.
  const wasOpen = useRef(open)
  useEffect(() => {
    const closed = wasOpen.current && !open
    wasOpen.current = open
    if (!closed || !document.hasFocus()) return
    const active = document.activeElement
    if (active === document.body || section.current?.contains(active)) gui.focusPreview()
  }, [open])
  // It slides up from the window's bottom edge as the preview's edge rises over it, and back
  // down; while it goes it's still drawn open, over the canvas that already has its room.
  const leaving = useLayoutSlide(open, section, { edge: 'bottom' })
  const drawn = open || leaving
  const body = useRef<HTMLDivElement>(null)
  const size = useDrawerSize(state.drawerHeight, section, body, open)
  const tabList = useRef<HTMLDivElement>(null)
  // More terminals than fit: the row scrolls, and the one shown is always in it.
  useScrollingTabs(tabList, drawn ? (state.drawer.tab ?? 'server') : null)

  const { project, drawer } = state
  if (!project) return null
  const { terminals } = drawer
  const shown = drawer.tab ?? 'server'
  const failed = crashed(state)
  const outside = stoppedOutside(state)
  const exited = terminals.find((terminal) => terminal.id === shown)?.exited ?? false

  const tabs: TabEntry[] = [
    {
      tab: 'server',
      label: 'Dev server',
      note: serverStatus(state).label,
      icon: (
        <span className="flex size-3.5 shrink-0 items-center justify-center">
          <StatusDot status={serverStatus(state).status} />
        </span>
      ),
      errors: state.serverErrors,
    },
    ...terminals.map(
      (terminal): TabEntry => ({
        tab: terminal.id,
        label: terminal.title,
        icon: <SquareTerminal className="size-3.5 shrink-0" aria-hidden="true" />,
        note: terminal.exited ? 'exited' : undefined,
      }),
    ),
  ]

  const select = (tab: DrawerTab, focus: boolean) => {
    if (tab !== shown) gui.selectDrawerTab(tab)
    if (focus) setFocusRequest(tab)
  }

  /** The pointer's ×: the drawer shows the neighbor, which takes the keyboard. */
  const close = (id: TerminalId) => {
    if (id === shown) setFocusRequest(drawerNeighbor(terminals, id))
    gui.closeTerminal(id)
  }

  return (
    <>
      {!drawn &&
        !state.focusMode &&
        state.devServer.status === 'exited' &&
        state.preview.visible && (
          <StoppedBar crashed={failed} outside={outside} agentId={state.agentId} />
        )}
      {/* Kept mounted while closed, so the terminals keep their scrollback and place. */}
      <section
        ref={section}
        aria-label="Terminal"
        inert={!open}
        className={cn(
          // Chrome over the canvas while it slides away on top of it.
          'z-chrome shrink-0 bg-surface',
          leaving ? 'absolute inset-x-0 bottom-0' : 'relative',
          drawn && 'border-t-hairline border-line',
        )}
      >
        {open && <DrawerEdge size={size} />}
        {drawn && (
          // The header recipe, but its tabs carry their own inset, so the first label lands
          // near the 12px the recipe gives a title. Over the terminal's darker canvas, no
          // hairline is needed.
          <PanelHeader
            borderless
            className="pl-1.5"
            actions={
              <IconButton
                className={TIGHT_HIT_AREA}
                label="Hide terminal"
                shortcut="toggleTerminal"
                icon={ChevronDown}
                size="sm"
                onClick={() => gui.setDrawerOpen(false)}
              />
            }
          >
            {/*
             * Tabs only, as in the tab strip. A terminal's × is for the pointer and hidden from
             * assistive tech; from the keyboard, Delete on its tab ends it.
             */}
            <div
              ref={tabList}
              role="tablist"
              aria-label="Terminal tabs"
              className={cn(SCROLLING_TABLIST, 'shrink')}
            >
              {tabs.map((entry, index) => {
                const selected = entry.tab === shown
                const terminal = entry.tab === 'server' ? null : entry.tab
                return (
                  <div
                    key={entry.tab}
                    role="presentation"
                    className={cn(
                      tabClass('segment', selected),
                      // They narrow to this, then the row scrolls.
                      'min-w-20 transition-[color,background-color]',
                    )}
                  >
                    <button
                      type="button"
                      role="tab"
                      id={tabId(entry.tab)}
                      aria-controls={panelId(entry.tab)}
                      aria-selected={selected}
                      tabIndex={selected ? 0 : -1}
                      aria-label={tabName(entry)}
                      title={tabName(entry) ?? entry.label}
                      // A click shows it and puts the keyboard in it; Enter or Space only shows it.
                      onClick={(event) => select(entry.tab, event.detail > 0)}
                      // The middle button ends a terminal, rather than starting to scroll.
                      onMouseDown={(event) => {
                        if (event.button === 1) event.preventDefault()
                      }}
                      onAuxClick={(event) => {
                        if (event.button === 1 && terminal) close(terminal)
                      }}
                      onKeyDown={(event) =>
                        rovingTabKeyDown(event, {
                          index,
                          count: tabs.length,
                          select: (target) => {
                            const next = tabs[target]
                            if (next) select(next.tab, false)
                          },
                          // Main shows the neighbor, which has the keyboard. The dev server's
                          // output can't be closed.
                          close: terminal ? () => gui.closeTerminal(terminal) : undefined,
                        })
                      }
                      className={cn(TAB_LABEL, 'pl-2', PRESS, terminal ? 'pr-7' : 'pr-2.5')}
                    >
                      {entry.icon}
                      <span className={cn('truncate', entry.note && 'text-subtle')}>
                        {entry.label}
                      </span>
                      {!!entry.errors && (
                        <span aria-hidden="true" className="text-caption text-danger tabular-nums">
                          {entry.errors}
                        </span>
                      )}
                    </button>
                    {/* Always there: tabs here are as wide as their names, so a hidden one
                        would leave a gap. */}
                    {terminal && (
                      <TabCloseButton name={entry.label} onClose={() => close(terminal)} />
                    )}
                  </div>
                )
              })}
            </div>
            <IconButton
              className={TIGHT_HIT_AREA}
              label="New terminal"
              icon={Plus}
              size="sm"
              onClick={() => gui.newTerminal()}
            />
            <div className="flex min-w-0 flex-1 items-center justify-end gap-2 pl-2">
              {shown === 'server' ? (
                <>
                  <span
                    title={state.devServer.command ?? undefined}
                    className="min-w-0 truncate font-mono text-caption text-subtle"
                  >
                    {state.devServer.command}
                  </span>
                  {failed && (
                    <>
                      <span className="shrink-0 text-small text-danger">Stopped with an error</span>
                      <FixStartupButton agentId={state.agentId} variant="secondary" size="sm" />
                      <Button size="sm" onClick={() => gui.restartDevServer()}>
                        Restart
                      </Button>
                    </>
                  )}
                </>
              ) : (
                exited && (
                  <Button
                    size="sm"
                    onClick={() => {
                      gui.restartTerminal(shown)
                      setFocusRequest(shown)
                    }}
                  >
                    Restart
                  </Button>
                )
              )}
            </div>
          </PanelHeader>
        )}
        <div
          ref={body}
          className="relative overflow-hidden bg-canvas"
          // As tall as the user dragged it, with nothing easing it: it follows the pointer.
          style={{ height: drawn ? size.height : 0 }}
        >
          {/* First, so it's the drawer's first terminal on the page. Keyed by project, so each
              project gets a fresh one with its own log history. */}
          <Panel tab="server" shown={shown === 'server'}>
            <LogsView
              key={project.root}
              active={open && shown === 'server'}
              focus={open && shown === 'server' && focusRequest === 'server'}
              onFocused={() => setFocusRequest(null)}
            />
          </Panel>
          {terminals.map((terminal) => (
            <Panel key={terminal.id} tab={terminal.id} shown={shown === terminal.id}>
              <ShellView
                id={terminal.id}
                active={open && shown === terminal.id}
                focus={open && shown === terminal.id && focusRequest === terminal.id}
                onFocused={() => setFocusRequest(null)}
              />
            </Panel>
          ))}
        </div>
      </section>
    </>
  )
}

interface DrawerSize {
  /** How tall the terminal area is drawn: the remembered height, fitted to the window */
  height: number
  /** The tallest it can be drawn in this window */
  max: number
  /** Draws it `height` tall (fitted) now; `remember` keeps that for every window */
  set(height: number, remember: boolean): void
}

/**
 * The terminal area's height: the one the user left it at (`remembered`, from prefs), drawn
 * to fit the room under the canvas. A short window draws it shorter and still remembers it.
 */
function useDrawerSize(
  remembered: number,
  section: RefObject<HTMLElement | null>,
  body: RefObject<HTMLDivElement | null>,
  open: boolean,
): DrawerSize {
  const [height, setHeight] = useState(remembered)
  // Heights this window sent main and hasn't heard back yet. Coming back, each is already
  // drawn (or a newer one is); any other is another window's, drawn here too.
  const sent = useRef<number[]>([])
  useEffect(() => {
    const echo = sent.current.indexOf(remembered)
    if (echo >= 0) sent.current = sent.current.slice(echo + 1)
    else setHeight(remembered)
  }, [remembered])
  // The height the canvas and the terminal area share: from the canvas's top to the window's
  // bottom, less the drawer's tab row and edge. Measured as the canvas resizes (the window, a
  // banner over it); its top doesn't move as the drawer does, so this settles at once.
  const [room, setRoom] = useState(Number.POSITIVE_INFINITY)
  useLayoutEffect(() => {
    const el = section.current
    const canvas = el?.previousElementSibling
    if (!open || !el || !(canvas instanceof HTMLElement) || !body.current) return
    const measure = () => {
      const terminals = body.current
      if (!terminals) return
      // Its tab row and edge from offsets, which the slide's transform doesn't move.
      const above = el.offsetHeight - terminals.offsetHeight
      setRoom(window.innerHeight - canvas.getBoundingClientRect().top - above)
    }
    const observer = new ResizeObserver(measure)
    observer.observe(canvas)
    window.addEventListener('resize', measure)
    measure()
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', measure)
    }
  }, [open, section, body])

  const drawn = drawerHeight(height, room)
  return {
    height: drawn,
    max: drawerHeight(Number.POSITIVE_INFINITY, room),
    set(next, remember) {
      const fitted = drawerHeight(next, room)
      // At once, so the canvas reports its new size to main in this frame and the preview
      // moves with the drawer.
      flushSync(() => setHeight(fitted))
      // Main keeps only a change, and says so only then.
      if (!remember || fitted === (sent.current.at(-1) ?? remembered)) return
      sent.current.push(fitted)
      gui.setDrawerHeight(fitted)
    },
  }
}

/**
 * The drawer's top edge: dragged, it makes the terminal area taller or shorter, the preview
 * giving way above; double-clicked, back to the usual height. A separator the keyboard
 * reaches by Tab, whose up and down arrows resize it. Dragging leaves the keyboard where it
 * was, in the terminal. The hit area straddles the edge; a preview over the canvas covers
 * its upper part, so it reaches 8px into the drawer.
 */
function DrawerEdge({ size }: { size: DrawerSize }) {
  const [dragging, setDragging] = useState(false)
  const onPointerDown = (event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0) return
    // No text selection or focus change while dragging.
    event.preventDefault()
    const from = size.height
    let height = from
    let pulled = 0
    setDragging(true)
    trackDrag(
      event,
      (_dx, dy) => {
        pulled += dy
        height = drawerHeight(from - pulled, Number.POSITIVE_INFINITY)
        size.set(height, false)
      },
      () => {
        setDragging(false)
        if (height !== from) size.set(height, true)
      },
    )
  }
  const onKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    const step = { ArrowUp: DRAWER_HEIGHT.step, ArrowDown: -DRAWER_HEIGHT.step }[event.key]
    if (!step) return
    event.preventDefault()
    size.set(size.height + step, true)
  }
  return (
    // biome-ignore lint/a11y/useSemanticElements: an <hr> can't hold the keyboard to resize.
    <div
      role="separator"
      tabIndex={0}
      aria-label="Resize terminal"
      aria-orientation="horizontal"
      aria-valuenow={size.height}
      aria-valuemin={DRAWER_HEIGHT.min}
      aria-valuemax={size.max}
      aria-valuetext={`${size.height} pixels tall`}
      data-dragging={dragging || undefined}
      onPointerDown={onPointerDown}
      onDoubleClick={() => size.set(DRAWER_HEIGHT.default, true)}
      onKeyDown={onKeyDown}
      className={cn(
        // 4px over the canvas, 8px into the drawer.
        'absolute inset-x-0 -top-1 z-sticky h-3 cursor-row-resize outline-none',
        // Its line lies just under the drawer's border (the preview's view, snapped to whole
        // pixels, covers the hairline itself): a little stronger with the pointer on it or
        // dragging, and as the keyboard's ring with the keyboard on it.
        'after:absolute after:inset-x-0 after:top-1 after:h-(--hairline) after:bg-line-strong after:opacity-0 after:transition-opacity',
        'hover:after:opacity-100 focus-visible:after:bg-muted focus-visible:after:opacity-100 data-dragging:after:opacity-100',
      )}
    />
  )
}

/** A tab's name with what's read after it (exited, its errors); undefined when it's the label alone. */
function tabName({ label, note, errors }: TabEntry) {
  const count = errors ? (errors === 1 ? '1 error' : `${errors} errors`) : undefined
  const extra = [note, count].filter(Boolean)
  return extra.length ? [label, ...extra].join(', ') : undefined
}

/** A tab's terminal: all stay laid out at the drawer's size, the ones not shown invisible. */
function Panel({ tab, shown, children }: { tab: DrawerTab; shown: boolean; children: ReactNode }) {
  return (
    <div
      role="tabpanel"
      id={panelId(tab)}
      aria-labelledby={tabId(tab)}
      className={cn('absolute inset-0 px-3 py-2', !shown && 'invisible')}
    >
      <Suspense fallback={null}>{children}</Suspense>
    </div>
  )
}

/**
 * Under a preview whose app is gone: it crashed (an alert, with the logs to see why), or
 * it exited cleanly or something outside Gui stopped it (said calmly, with a way to restart).
 */
function StoppedBar({
  crashed,
  outside,
  agentId,
}: {
  crashed: boolean
  outside: boolean
  agentId: AgentId
}) {
  return (
    // The banner's soft tint goes over the window's surface, as the rest of the chrome's bars.
    <div className="relative z-chrome shrink-0 bg-surface">
      <Banner
        wrap={false}
        edge="bottom"
        tone={crashed ? 'danger' : 'neutral'}
        icon={crashed ? TriangleAlert : Info}
        role={crashed ? 'alert' : 'status'}
        actions={
          <>
            <Button variant="ghost" size="sm" onClick={() => gui.showLogs()}>
              Show logs
            </Button>
            {crashed && <FixStartupButton agentId={agentId} variant="secondary" size="sm" />}
            <Button size="sm" onClick={() => gui.restartDevServer()}>
              {outside ? 'Start' : 'Restart'}
            </Button>
          </>
        }
      >
        <span className="truncate">
          {crashed
            ? 'Your app stopped with an error.'
            : outside
              ? 'Your app was stopped outside Gui.'
              : 'Your app stopped.'}
        </span>
      </Banner>
    </div>
  )
}
