import {
  type FocusEvent,
  type KeyboardEvent,
  type MouseEvent,
  type RefObject,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react'
import { createPortal } from 'react-dom'
import { ariaShortcut, withShortcut } from '../../../shared/shortcuts'
import { replyRunning } from '../../../shared/stop-question'
import {
  type AgentChoice,
  type AgentId,
  type AgentModelList,
  type AgentSetting,
  agentName,
  type ChatMeta,
} from '../../../shared/types'
import { AgentIcon } from '../agents/agent-icon'
import { gui } from '../lib/api'
import { cn } from '../lib/cn'
import { ChevronDown, Clock, Settings } from '../lib/icons'
import { motionMs, usePresence } from '../lib/motion'
import {
  GroupLabel,
  MenuRow,
  Popover,
  PopoverNote,
  type PopoverPlacement,
  PopoverSearch,
  placePopover,
} from '../lib/surface'
import { Button, HIT_AREA, IconButton, OPEN, SegmentedControl } from '../lib/ui'
import {
  modelEntries,
  rowKey,
  type Section,
  searchSections,
  sections,
  shortName,
} from './model-search'
import { StopQuestion } from './stop-question'
import { useChat, whenPanelShown } from './store'

/**
 * Whether the effort levels fit side by side in a picker this wide without cutting any
 * label short; if not, they go one per row. A cautious estimate of the 12px medium text,
 * 7.5px a character, plus each segment's padding and gap, inside the section's padding.
 */
function segmentsFit(labels: string[], width: number) {
  const text = labels.reduce((sum, label) => sum + label.length * 7.5, 0)
  return text + labels.length * 14 <= width - 20
}

/**
 * At most this many frames for the panel to settle before ⇧⌘M opens the picker: the view to
 * stop resizing, and the panel to finish growing out of the bubble.
 */
const SETTLE_FRAMES = 60

/**
 * Calls `fn` once the view has kept its size for a frame, or after `frames`. ⇧⌘M can bring
 * the panel back as it asks (from its bubble, say), and the picker closes on a resize.
 */
export function whenSettled(button: HTMLElement | null, fn: () => void, frames = SETTLE_FRAMES) {
  let size = `${window.innerWidth}×${window.innerHeight}`
  let left = frames
  // The panel scales while it morphs (morph.ts); measured then, the picker would be misplaced.
  const morphing = () => !!button?.closest<HTMLElement>('[data-chat-form]')?.style.transform
  const check = () => {
    const now = `${window.innerWidth}×${window.innerHeight}`
    if ((now === size && !morphing()) || --left <= 0) return fn()
    size = now
    requestAnimationFrame(check)
  }
  requestAnimationFrame(check)
}

/** The selected choice's name; null when the agent reports a value it doesn't list. */
function choiceName(setting: AgentSetting) {
  return setting.options.find((option) => option.value === setting.value)?.name ?? null
}

/**
 * A setting's choices in the picker (effort levels, providers): side by side when they fit
 * a picker `width` wide, else one per row, like the models. Each applies on click and
 * leaves the picker open.
 */
function SettingChoices({
  labelId,
  choices,
  value,
  width,
  onChange,
}: {
  labelId: string
  choices: { value: string; label: string }[]
  value: string
  width: number
  onChange: (value: string) => void
}) {
  const labels = choices.map((choice) => choice.label)
  if (segmentsFit(labels, width)) {
    return (
      <SegmentedControl
        aria-labelledby={labelId}
        segments={choices.map((choice) => ({ ...choice, title: choice.label }))}
        value={value}
        onChange={onChange}
        stretch
      />
    )
  }
  return (
    <fieldset aria-labelledby={labelId} className="flex flex-col">
      {choices.map((choice) => {
        const on = choice.value === value
        return (
          <MenuRow
            key={choice.value}
            as="button"
            selected={on}
            aria-pressed={on}
            onClick={() => onChange(choice.value)}
          >
            {choice.label}
          </MenuRow>
        )
      })}
    </fieldset>
  )
}

/**
 * Gui's own names for the effort levels agents share, so they read the same whichever
 * agent offers them ("xhigh" isn't "Xhigh"). Any other level keeps the agent's name.
 */
const EFFORT_LABELS: Record<string, string> = {
  // fx names it "default"; it picks the level itself.
  auto: 'Auto',
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Max',
}

function effortLabel(choice: { value: string; name: string }) {
  return Object.hasOwn(EFFORT_LABELS, choice.value) ? EFFORT_LABELS[choice.value] : choice.name
}

/** The selected effort's label; the raw value when the agent reports one it doesn't list. */
function effortName(setting: AgentSetting) {
  const choice = setting.options.find((option) => option.value === setting.value)
  return choice ? effortLabel(choice) : setting.value
}

/**
 * What the next turn runs on: the agent's model and effort, or the agent alone when it has
 * no models to choose. Opens the picker, which changes the model, the effort and the agent.
 */
export function ModelButton({ meta }: { meta: ChatMeta }) {
  const models = meta.models
  const [open, setOpen] = useState(false)
  const [instant, setInstant] = useState(false)
  // Kept while it closes, which it does where it was.
  const [placement, setPlacement] = useState<PopoverPlacement | null>(null)
  const shown = usePresence(open, motionMs('--motion-exit'))
  const button = useRef<HTMLButtonElement>(null)
  const pickerId = useId()
  const fullName = models ? (choiceName(models.model) ?? models.model.value) : null
  const model = fullName && shortName(fullName)
  const effort = models?.effort ? effortName(models.effort) : null
  const provider = models?.provider ? choiceName(models.provider) : null
  const label = model
    ? effort
      ? `Model: ${model}, effort ${effort}`
      : `Model: ${model}`
    : `Agent: ${meta.agentName}`
  const pickModel = useChat((s) => s.pickModel)

  // ⇧⌘M (Agent → Choose Model…): open, searching.
  useEffect(() => {
    if (!pickModel) return
    setInstant(true)
    useChat.setState({ pickModel: false })
    whenPanelShown(() =>
      whenSettled(button.current, () => {
        if (!button.current) return
        setPlacement(placePopover(button.current))
        setOpen(true)
      }),
    )
  }, [pickModel])

  const close = (refocus: boolean) => {
    setOpen(false)
    if (refocus) button.current?.focus()
  }

  return (
    <>
      <Button
        ref={button}
        variant="ghost"
        trailingIcon={ChevronDown}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? pickerId : undefined}
        aria-label={label}
        title={withShortcut(
          [meta.agentName, provider, fullName, effort].filter(Boolean).join(' · '),
          'chooseModel',
        )}
        aria-keyshortcuts={ariaShortcut('chooseModel')}
        onClick={() => {
          if (open) return close(false)
          setInstant(false)
          // The message box alone has no room for it: the panel grows first.
          whenPanelShown(() => {
            if (!button.current) return
            setPlacement(placePopover(button.current))
            setOpen(true)
          })
        }}
        // On while its picker is open, as a pressed IconButton.
        className={cn('min-w-0', HIT_AREA, OPEN)}
      >
        {/* A long model name gives way; the effort stays readable, unless the row is too
            narrow for both (the floating chat's default width), when it's left to the
            tooltip and the picker so the model name reads whole rather than "Sonne…". */}
        <span className="flex min-w-0">
          <span className="truncate">{model ?? meta.agentName}</span>
          {effort && <span className="shrink-0 whitespace-pre @max-sm:hidden"> · {effort}</span>}
        </span>
      </Button>
      {shown && placement && (
        <ModelPicker
          // A fresh picker for each opening; the one closing goes as it was.
          key={`${placement.left},${placement.top},${placement.bottom}`}
          id={pickerId}
          instant={instant}
          open={open}
          meta={meta}
          placement={placement}
          button={button}
          onClose={close}
        />
      )}
    </>
  )
}

interface ModelPickerProps {
  instant: boolean
  id: string
  /** False while it closes */
  open: boolean
  meta: ChatMeta
  placement: PopoverPlacement
  button: RefObject<HTMLButtonElement | null>
  /** `refocus` returns focus to the button (Esc, a pick); not after a click elsewhere. */
  onClose: (refocus: boolean) => void
}

/** Another agent the user picked while the chat works: asked about before it's stopped. */
interface Switch {
  agentId: AgentId
  /** The model to start it on; null for the agent alone */
  model: string | null
  modelName: string | null
  provider: string | null
}

/** What a not-ready agent's tab says in place of its models. */
function stateText(choice: AgentChoice, hasModels: boolean) {
  switch (choice.status) {
    case 'unknown':
    case 'checking':
      return 'Checking'
    case 'installing':
      return 'Installing…'
    case 'signing-in':
      return 'Signing in…'
    default:
      return choice.note ?? (hasModels ? null : 'No models to choose')
  }
}

/**
 * What the chat runs on, in one place. A strip of tabs across the top: Recent (the models used
 * last, from any agent), then each agent, then Agent Settings…. An agent's tab lists its
 * models under their provider; the chat's own agent also has its Provider row (fx) and effort
 * levels. Typing searches every agent's models at once. A model of the chat's agent applies on
 * pick; another agent's takes this chat while nothing has been said in it, and starts a new
 * chat on it after that. While the chat works or has messages queued, that asks first: yes
 * stops it, archives it, and starts the other agent.
 */
function ModelPicker({ id, instant, open, meta, placement, button, onClose }: ModelPickerProps) {
  const { models, agents, agentId, recentModels } = meta
  const model = models?.model ?? null
  const effort = models?.effort ?? null
  const provider = models?.provider ?? null
  const root = useRef<HTMLDivElement>(null)
  const searchField = useRef<HTMLInputElement>(null)
  const strip = useRef<HTMLDivElement>(null)
  const cancel = useRef<HTMLButtonElement>(null)
  const listId = `${id}-list`
  const effortId = `${id}-effort`
  const providerId = `${id}-provider`
  const questionId = `${id}-question`
  /** The provider asked for, until the agent answers */
  const [switching, setSwitching] = useState<string | null>(null)
  /** Why the agent turned the last provider down */
  const [refusal, setRefusal] = useState<string | null>(null)
  /** The tab: an agent, or null for Recent. It opens on Recent once there's something in it. */
  const [tab, setTab] = useState<AgentId | null>(recentModels.length ? null : agentId)
  const [query, setQuery] = useState('')
  const [asking, setAsking] = useState<Switch | null>(null)
  const hasTurns = useChat((s) => s.turnIds.length > 0)
  // Said or waiting to be said: the chat keeps its agent.
  const started = hasTurns || meta.queue.length > 0
  // Another agent now would cut the turn short or drop the queue: asked about first.
  const busy = replyRunning(meta)
  const searching = query.trim() !== ''
  const currentKey = model ? rowKey(agentId, provider?.value ?? null, model.value) : null
  /** The highlighted row's key; null for the first. */
  const [active, setActive] = useState<string | null>(currentKey)

  // An agent switched off meanwhile has no tab: its agent's own instead.
  const shownTab = tab === null || agents.some((agent) => agent.id === tab) ? tab : agentId
  const nameOf = (agent: AgentId) =>
    agent === agentId
      ? meta.agentName
      : (agents.find((choice) => choice.id === agent)?.name ?? agentName(agent))
  /** Each agent's models: the chat's own from its settings, the others' from their checks. */
  const listOf = (choice: AgentChoice): AgentModelList | null =>
    choice.id === agentId
      ? models && { model: models.model, provider: models.provider }
      : choice.models
  const entriesOf = (choice: AgentChoice) => {
    const list = listOf(choice)
    return list ? modelEntries(choice, list) : []
  }
  const dimmed = (choice: AgentChoice) =>
    !listOf(choice) && choice.status !== 'ready' && !(choice.id === agentId && !meta.agent)

  // Another agent picked elsewhere (another window, the menu): its list, from the top.
  const [listedAgent, setListedAgent] = useState(agentId)
  if (listedAgent !== agentId) {
    setListedAgent(agentId)
    setQuery('')
    setAsking(null)
    setActive(currentKey)
  }
  // Another provider's models: what's typed still filters them; with nothing typed, the
  // current model is the one on.
  const [listedProvider, setListedProvider] = useState(provider?.value ?? null)
  if (listedProvider !== (provider?.value ?? null)) {
    setListedProvider(provider?.value ?? null)
    setActive(searching ? null : currentKey)
  }

  const pickProvider = (value: string) => {
    if (!provider || switching !== null || value === provider.value) return
    setSwitching(value)
    setRefusal(null)
    void gui
      .setProvider(value)
      .then(setRefusal, (error: unknown) => setRefusal(String(error)))
      .finally(() => setSwitching(null))
  }

  const tabChoice =
    shownTab === null ? null : (agents.find((agent) => agent.id === shownTab) ?? null)
  const tabList = tabChoice && listOf(tabChoice)
  let shown: Section[] = []
  if (searching) {
    // The chat's own agent first: its models apply in place.
    const own = agents.filter((agent) => agent.id === agentId)
    const others = agents.filter((agent) => agent.id !== agentId)
    shown = searchSections(
      [...own, ...others].map((agent) => ({ ...agent, entries: entriesOf(agent) })),
      query,
    )
  } else if (shownTab === null) {
    const rows = recentModels.map((recent, index) => ({
      entry: {
        key: rowKey(recent.agentId, recent.provider, recent.model),
        agentId: recent.agentId,
        agentName: nameOf(recent.agentId),
        value: recent.model,
        provider: recent.provider,
        label: shortName(recent.name),
        name: recent.name,
        group: null,
      },
      index,
    }))
    shown = rows.length ? [{ key: 'recent', agentId: null, label: null, rows }] : []
  } else if (tabChoice && tabList) {
    shown = sections(entriesOf(tabChoice))
  }
  const rows = asking ? [] : shown.flatMap((section) => section.rows)
  const activeIndex = Math.max(
    0,
    rows.findIndex((row) => row.entry.key === active),
  )
  const optionId = (index: number) => `${id}-option-${index}`
  const activeId = rows[activeIndex] ? optionId(activeIndex) : undefined
  // The chat's own model's effort, beside the chat's own models.
  const ownRows = searching
    ? rows.length > 0 && rows.every((row) => row.entry.agentId === agentId)
    : shownTab === null || shownTab === agentId
  const showEffort = !asking && effort && ownRows
  const showProvider = !asking && provider && !searching && shownTab === agentId
  // Why a model of another agent starts a new chat, said before the pick rather than after.
  const showHint = !asking && !searching && started && rows.length > 0 && shownTab !== agentId

  /** The tabs, Recent first, as the arrow keys go through them. */
  const tabs: (AgentId | null)[] = [null, ...agents.map((agent) => agent.id)]
  const tabId = (value: AgentId | null) => `${id}-tab-${value === null ? 0 : tabs.indexOf(value)}`

  const selectTab = (value: AgentId | null) => {
    setTab(value)
    setQuery('')
    setAsking(null)
    setActive(currentKey)
  }

  // On opening, and on opening again while it closed.
  useEffect(() => {
    if (open) searchField.current?.focus()
  }, [open])

  useEffect(() => {
    if (activeId) document.getElementById(activeId)?.scrollIntoView({ block: 'nearest' })
  }, [activeId])

  // The tab it shows stays in sight in a strip that scrolls.
  // biome-ignore lint/correctness/useExhaustiveDependencies: on another tab
  useEffect(() => {
    const on = strip.current?.querySelector('[aria-selected="true"]')
    on?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [shownTab])

  useEffect(() => {
    if (asking) cancel.current?.focus()
  }, [asking])

  // A click elsewhere in the chat, or anywhere outside it (the view loses focus), closes
  // it; so does a resize, which moves the button.
  useEffect(() => {
    if (!open) return
    const outside = (event: PointerEvent) => {
      const target = event.target
      if (!(target instanceof Node)) return
      if (root.current?.contains(target) || button.current?.contains(target)) return
      onClose(false)
    }
    const dismiss = () => onClose(false)
    document.addEventListener('pointerdown', outside, true)
    window.addEventListener('blur', dismiss)
    window.addEventListener('resize', dismiss)
    return () => {
      document.removeEventListener('pointerdown', outside, true)
      window.removeEventListener('blur', dismiss)
      window.removeEventListener('resize', dismiss)
    }
  }, [open, button, onClose])

  /** Another agent: now, or once the user says to stop this chat's work. */
  const switchTo = (next: Switch) => {
    if (started && busy) return setAsking(next)
    if (next.model !== null) gui.pickModel(next.agentId, next.model, next.provider, false)
    else if (started) gui.newSession(next.agentId)
    else gui.setAgent(next.agentId)
    onClose(true)
  }

  const stopAndSwitch = (next: Switch) => {
    if (next.model !== null) gui.pickModel(next.agentId, next.model, next.provider, true)
    else gui.newSession(next.agentId, true)
    onClose(true)
  }

  const closeQuestion = () => {
    setAsking(null)
    searchField.current?.focus()
  }

  const pick = ({ entry }: (typeof rows)[number]) => {
    if (entry.agentId !== agentId) {
      const modelName = shortName(entry.name)
      return switchTo({ ...entry, model: entry.value, modelName })
    }
    // Under another provider (a recent one): the agent switches to it first.
    if (entry.provider !== (provider?.value ?? null)) {
      gui.pickModel(agentId, entry.value, entry.provider, false)
    } else if (model) gui.setAgentSetting(model.id, entry.value)
    onClose(true)
  }

  const onSearch = (text: string) => {
    setQuery(text)
    setAsking(null)
    // The first match; with the search cleared, the current choice again.
    setActive(text.trim() ? null : currentKey)
  }

  /** ↑/↓ and Enter, from the search field. */
  const onListKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const step = event.key === 'ArrowDown' ? 1 : -1
      const next = rows[Math.min(Math.max(activeIndex + step, 0), rows.length - 1)]
      if (next) setActive(next.entry.key)
    } else if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
      event.preventDefault()
      const row = rows[activeIndex]
      if (row) pick(row)
    }
  }

  /** ←/→, Home and End along the tabs, each shown as it's reached. */
  const onTabKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const at = tabs.indexOf(searching ? null : shownTab)
    const to =
      event.key === 'ArrowRight'
        ? Math.min(at + 1, tabs.length - 1)
        : event.key === 'ArrowLeft'
          ? Math.max(at - 1, 0)
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? tabs.length - 1
              : null
    if (to === null) return
    event.preventDefault()
    selectTab(tabs[to])
    document.getElementById(tabId(tabs[to]))?.focus()
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape' && !event.nativeEvent.isComposing) {
      event.preventDefault()
      // The question goes back to the list; otherwise the picker closes.
      if (asking) closeQuestion()
      else onClose(true)
      return
    }
    // Typing anywhere in the picker goes to the search field.
    const typed = event.key.length === 1 && event.key !== ' '
    const field = searchField.current
    if (field && typed && event.target !== field && !event.metaKey && !event.ctrlKey) {
      field.focus()
    }
  }

  // Focus stays in the search field when clicking rows and headers.
  const onMouseDown = (event: MouseEvent<HTMLDivElement>) => {
    if (!(event.target instanceof Element && event.target.closest('input, button'))) {
      event.preventDefault()
    }
  }

  const onBlur = (event: FocusEvent<HTMLDivElement>) => {
    const next = event.relatedTarget
    if (!(next instanceof Node) || event.currentTarget.contains(next)) return
    if (!button.current?.contains(next)) onClose(false)
  }

  const renderRow = (row: (typeof rows)[number]) => {
    const { entry, index } = row
    const selected = entry.key === currentKey
    const other = entry.agentId !== agentId
    // Recent says whose each model is; search results say what picking another agent's does.
    const note =
      !searching && shownTab === null
        ? entry.agentName
        : searching && other && started
          ? 'New chat'
          : null
    return (
      // Focus stays on the search field, which handles the keys and points at the
      // highlighted option through aria-activedescendant.
      <MenuRow
        key={entry.key}
        id={optionId(index)}
        role="option"
        aria-selected={selected}
        title={[entry.name, other ? entry.agentName : null, note === 'New chat' ? note : null]
          .filter(Boolean)
          .join(' · ')}
        highlighted={index === activeIndex}
        selected={selected}
        className="hover:bg-accent-soft hover:text-accent-text hover:**:text-accent-text"
        onClick={() => pick(row)}
      >
        {note !== null || shownTab === null ? (
          <span className="flex min-w-0 items-center gap-2">
            {!searching && shownTab === null && <AgentIcon agentId={entry.agentId} small />}
            <span className="min-w-0 flex-1 truncate">{entry.label}</span>
            {note && <span className="shrink-0 text-subtle">{note}</span>}
          </span>
        ) : (
          entry.label
        )}
      </MenuRow>
    )
  }

  const tabButton = (value: AgentId | null, index: number) => {
    const on = !searching && value === shownTab
    const choice = value === null ? null : agents.find((agent) => agent.id === value)
    const name = choice ? choice.name : 'Recent'
    return (
      <button
        key={value ?? ''}
        type="button"
        role="tab"
        id={tabId(value)}
        aria-selected={on}
        aria-label={name}
        title={name}
        // One stop for Tab: the tab shown, or Recent while searching.
        tabIndex={on || (searching && index === 0) ? 0 : -1}
        onClick={() => {
          selectTab(value)
          searchField.current?.focus()
        }}
        className={cn(
          'relative flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted outline-none hover:bg-hover focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-muted',
          on &&
            'text-fg after:absolute after:inset-x-1 after:bottom-0 after:h-0.5 after:rounded-full after:bg-accent',
        )}
      >
        {choice ? (
          <AgentIcon agentId={choice.id} small className={cn(dimmed(choice) && 'opacity-35')} />
        ) : (
          <Clock className="size-4" aria-hidden="true" />
        )}
      </button>
    )
  }

  const question = asking && (
    <StopQuestion
      id={questionId}
      meta={meta}
      next={{ agentName: nameOf(asking.agentId), modelName: asking.modelName }}
      to={<AgentIcon agentId={asking.agentId} small />}
      cancel={cancel}
      onCancel={closeQuestion}
      onConfirm={() => stopAndSwitch(asking)}
    />
  )

  /** A tab with no models to list: why, and how to use the agent anyway. */
  const agentState = (choice: AgentChoice) => {
    const text = stateText(choice, false)
    const checking = choice.status === 'unknown' || choice.status === 'checking'
    return (
      <div className="flex shrink-0 flex-col items-start gap-2 pb-2">
        {text &&
          (checking ? (
            <PopoverNote loading>{text}</PopoverNote>
          ) : (
            <PopoverNote>{text}</PopoverNote>
          ))}
        {choice.id !== agentId && (
          <Button
            size="sm"
            className="mx-3"
            onClick={() =>
              switchTo({ agentId: choice.id, model: null, modelName: null, provider: null })
            }
          >
            {started ? `New Chat with ${choice.name}` : `Use ${choice.name}`}
          </Button>
        )}
      </div>
    )
  }

  return createPortal(
    <Popover
      instant={instant}
      ref={root}
      id={id}
      open={open}
      role="dialog"
      aria-label="Choose a model"
      onKeyDown={onKeyDown}
      onMouseDown={onMouseDown}
      onBlur={onBlur}
      placement={placement}
    >
      <div className="flex shrink-0 items-center gap-0.5 px-1.5 pt-1">
        <div
          ref={strip}
          role="tablist"
          aria-label="Agents"
          onKeyDown={onTabKeyDown}
          className="scrollbar-none flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto"
        >
          {tabs.map(tabButton)}
        </div>
        <IconButton
          label="Agent Settings…"
          icon={Settings}
          className="h-7 w-7"
          onClick={() => {
            gui.openAgentSettings()
            onClose(false)
          }}
        />
      </div>
      <div className="mt-1 border-t-hairline border-line">
        <PopoverSearch
          ref={searchField}
          role="combobox"
          aria-label="Search all models"
          aria-controls={listId}
          aria-expanded
          aria-autocomplete="list"
          aria-activedescendant={activeId}
          placeholder="Search all models…"
          value={query}
          onChange={(event) => onSearch(event.target.value)}
          onKeyDown={onListKeyDown}
        />
      </div>
      {question}
      {!asking && showHint && (
        <p className="shrink-0 px-3 pt-2 pb-0.5 text-caption text-pretty text-subtle">
          A model from another agent starts a new chat.
        </p>
      )}
      {!asking && !searching && tabChoice && (
        <div className="flex shrink-0 items-baseline justify-between gap-2 px-3 pt-1.5 text-small font-medium">
          <span className="min-w-0 truncate">{tabChoice.name}</span>
          {tabList && (
            <span className="shrink-0 font-normal text-subtle">
              {tabList.model.options.length === 1
                ? '1 model'
                : `${tabList.model.options.length} models`}
            </span>
          )}
        </div>
      )}
      {showProvider && (
        <div
          aria-busy={switching !== null || undefined}
          className="flex shrink-0 flex-col gap-1.5 p-2"
        >
          <GroupLabel id={providerId} className="px-1">
            Provider
          </GroupLabel>
          <SettingChoices
            labelId={providerId}
            choices={provider.options.map((choice) => ({
              value: choice.value,
              label: choice.name,
            }))}
            value={switching ?? provider.value}
            width={placement.width}
            onChange={pickProvider}
          />
          {refusal && (
            <p role="alert" className="px-1 text-caption text-pretty text-danger">
              {refusal}
            </p>
          )}
        </div>
      )}
      {!asking && !searching && tabChoice && !tabList && agentState(tabChoice)}
      <div
        id={listId}
        role="listbox"
        aria-label="Models"
        tabIndex={-1}
        hidden={!!asking}
        className={cn(
          'min-h-0 overflow-y-auto scroll-stable overscroll-contain outline-none',
          rows.length > 0 && 'p-1',
        )}
      >
        {shown.map((section, number) =>
          section.label === null ? (
            section.rows.map(renderRow)
          ) : (
            // biome-ignore lint/a11y/useSemanticElements: a listbox groups its options with ARIA groups
            <div
              key={section.key}
              role="group"
              aria-labelledby={`${id}-group-${number}`}
              className="not-first:mt-1"
            >
              <GroupLabel
                as="div"
                id={`${id}-group-${number}`}
                // Pinned while its rows scroll under it (flush with the list's top, past its
                // p-1), so a long provider's models still say whose they are.
                className={cn(
                  'sticky -top-1 z-sticky truncate bg-overlay px-2 pt-1.5 pb-1',
                  section.agentId && 'flex items-center gap-1.5',
                )}
              >
                {section.agentId ? (
                  <>
                    <AgentIcon agentId={section.agentId} tiny />
                    <span className="min-w-0 truncate">{section.label}</span>
                  </>
                ) : (
                  section.label
                )}
              </GroupLabel>
              {section.rows.map(renderRow)}
            </div>
          ),
        )}
      </div>
      {!asking && searching && rows.length === 0 && <PopoverNote>No models match</PopoverNote>}
      {!asking && !searching && shownTab === null && rows.length === 0 && (
        <PopoverNote>No recent models</PopoverNote>
      )}
      {showEffort && (
        <div className="flex shrink-0 flex-col gap-1.5 border-t-hairline border-line p-2">
          <GroupLabel id={effortId} className="px-1">
            Effort
          </GroupLabel>
          <SettingChoices
            labelId={effortId}
            choices={effort.options.map((choice) => ({
              value: choice.value,
              label: effortLabel(choice),
            }))}
            value={effort.value}
            width={placement.width}
            onChange={(value) => gui.setAgentSetting(effort.id, value)}
          />
        </div>
      )}
    </Popover>,
    document.body,
  )
}
