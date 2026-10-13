// Functions injected into preview pages with executeJavaScript (via toString), so each
// must be self-contained: no imports or helpers from outside its own body.

export interface Target {
  ref?: string
  selector?: string
  text?: string
}

export type Located =
  | { error: string }
  | { x: number; y: number; description: string; coveredBy?: string; kind: 'select' | 'checkable' | 'text' | 'other' }

/** Builds an indented outline of the visible page and remembers interactive elements by ref. */
export function pageSnapshot(maxChars: number): string {
  const refs = new Map<string, Element>()
  ;(window as unknown as { __vibecanvasRefs: Map<string, Element> }).__vibecanvasRefs = refs
  const lines: string[] = []
  let size = 0
  let truncated = false
  let counter = 0

  const IMPLICIT: Record<string, string> = {
    A: 'link', BUTTON: 'button', SELECT: 'combobox', TEXTAREA: 'textbox', IMG: 'img', NAV: 'navigation',
    MAIN: 'main', HEADER: 'banner', FOOTER: 'contentinfo', ASIDE: 'complementary', FORM: 'form', UL: 'list',
    OL: 'list', LI: 'listitem', TABLE: 'table', TR: 'row', TH: 'columnheader', TD: 'cell', DIALOG: 'dialog',
    SUMMARY: 'button', IFRAME: 'iframe', VIDEO: 'video', OPTION: 'option', H1: 'heading', H2: 'heading',
    H3: 'heading', H4: 'heading', H5: 'heading', H6: 'heading', LABEL: 'label'
  }
  const INTERACTIVE = new Set([
    'link', 'button', 'textbox', 'searchbox', 'checkbox', 'radio', 'combobox', 'slider', 'switch', 'tab',
    'menuitem', 'option', 'spinbutton', 'listbox', 'clickable'
  ])
  // Roles whose name already says what's inside them.
  const LEAF = new Set(['link', 'button', 'heading', 'option', 'tab', 'menuitem', 'img', 'textbox', 'searchbox',
    'combobox', 'checkbox', 'radio', 'slider', 'switch', 'spinbutton', 'clickable'])
  const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'HEAD', 'META', 'LINK'])
  const MEANINGFUL =
    'a[href],button,input,select,textarea,[role],h1,h2,h3,h4,h5,h6,img,ul,ol,table,nav,main,header,footer,form,dialog,label,summary,iframe,video,[tabindex]'

  const clean = (s: string | null | undefined, max = 120) => {
    const t = (s ?? '').replace(/\s+/g, ' ').trim()
    return t.length > max ? `${t.slice(0, max - 1)}…` : t
  }

  const roleOf = (el: Element): string => {
    const explicit = el.getAttribute('role')
    if (explicit) return explicit.split(/\s+/)[0]
    if (el.tagName === 'A' && !el.hasAttribute('href')) return ''
    if (el.tagName === 'INPUT') {
      const type = (el as HTMLInputElement).type
      if (type === 'hidden') return ''
      if (type === 'checkbox' || type === 'radio') return type
      if (type === 'range') return 'slider'
      if (type === 'number') return 'spinbutton'
      if (type === 'search') return 'searchbox'
      if (['button', 'submit', 'reset', 'image'].includes(type)) return 'button'
      return 'textbox'
    }
    return IMPLICIT[el.tagName] ?? ''
  }

  const nameOf = (el: Element, role: string): string => {
    const label = el.getAttribute('aria-label')
    if (label) return clean(label)
    const labelledBy = el.getAttribute('aria-labelledby')
    if (labelledBy) {
      const text = labelledBy.split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? '').join(' ')
      if (clean(text)) return clean(text)
    }
    if (el instanceof HTMLImageElement) return clean(el.alt || el.title)
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) {
      const fromLabel = el.labels?.length ? [...el.labels].map((l) => l.innerText).join(' ') : ''
      if (el instanceof HTMLInputElement && ['button', 'submit', 'reset'].includes(el.type)) return clean(el.value || fromLabel)
      return clean(fromLabel || el.getAttribute('placeholder') || el.title)
    }
    if (LEAF.has(role) || ['label', 'listitem', 'cell', 'columnheader'].includes(role)) {
      return clean((el as HTMLElement).innerText || el.getAttribute('title'), role === 'listitem' ? 80 : 120)
    }
    return clean(el.getAttribute('title'))
  }

  const details = (el: Element, role: string): string => {
    const parts: string[] = []
    if (role === 'heading') parts.push(`level=${el.tagName.match(/^H(\d)$/)?.[1] ?? el.getAttribute('aria-level') ?? '?'}`)
    if (el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio')) {
      parts.push(el.checked ? 'checked' : 'unchecked')
    } else if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
      if (el.value) parts.push(`value=${JSON.stringify(el.type === 'password' ? '•••' : clean(el.value, 80))}`)
    } else if (el instanceof HTMLSelectElement) {
      parts.push(`value=${JSON.stringify(clean(el.selectedOptions[0]?.text ?? '', 60))}`)
    }
    const checked = el.getAttribute('aria-checked') ?? el.getAttribute('aria-pressed') ?? el.getAttribute('aria-selected')
    if (checked === 'true') parts.push('selected')
    const expanded = el.getAttribute('aria-expanded')
    if (expanded) parts.push(expanded === 'true' ? 'expanded' : 'collapsed')
    if ((el as HTMLButtonElement).disabled || el.getAttribute('aria-disabled') === 'true') parts.push('disabled')
    if (el instanceof HTMLAnchorElement && el.href) {
      const url = new URL(el.href, location.href)
      parts.push(`href=${url.origin === location.origin ? url.pathname + url.search + url.hash : url.href}`)
    }
    return parts.length ? ` (${parts.join(', ')})` : ''
  }

  const emit = (depth: number, text: string) => {
    if (truncated) return
    const line = '  '.repeat(depth) + text
    size += line.length + 1
    if (size > maxChars) {
      truncated = true
      return
    }
    lines.push(line)
  }

  const isVisible = (el: Element) =>
    typeof el.checkVisibility === 'function'
      ? el.checkVisibility({ checkVisibilityCSS: true, visibilityProperty: true } as CheckVisibilityOptions)
      : true

  const isClickable = (el: Element) => {
    if (!(el instanceof HTMLElement)) return false
    if (el.tabIndex >= 0 && el.hasAttribute('tabindex')) return true
    if (getComputedStyle(el).cursor !== 'pointer') return false
    const parent = el.parentElement
    return !parent || getComputedStyle(parent).cursor !== 'pointer'
  }

  const walk = (root: Element | ShadowRoot, depth: number) => {
    const children = root instanceof Element && root.shadowRoot ? [...root.shadowRoot.childNodes, ...root.childNodes] : [...root.childNodes]
    for (const child of children) {
      if (truncated) return
      if (child.nodeType === Node.TEXT_NODE) {
        const text = clean(child.textContent, 200)
        if (text) emit(depth, `- text: ${JSON.stringify(text)}`)
        continue
      }
      if (!(child instanceof Element) || SKIP.has(child.tagName)) continue
      if (child.getAttribute('aria-hidden') === 'true' || !isVisible(child)) continue
      if (child.tagName.toLowerCase() === 'svg' && !child.getAttribute('aria-label') && !child.getAttribute('role')) continue

      let role = roleOf(child)
      if (!role && isClickable(child)) role = 'clickable'
      if (!role) {
        // Plain containers of plain text read best as one line.
        if (!child.shadowRoot && !child.querySelector(MEANINGFUL) && child instanceof HTMLElement) {
          const text = clean(child.innerText, 300)
          if (text) emit(depth, `- text: ${JSON.stringify(text)}`)
        } else {
          walk(child, depth)
        }
        continue
      }
      const name = nameOf(child, role)
      let line = `- ${role}${name ? ` ${JSON.stringify(name)}` : ''}${details(child, role)}`
      if (INTERACTIVE.has(role)) {
        const ref = `e${++counter}`
        refs.set(ref, child)
        line += ` [ref=${ref}]`
      }
      emit(depth, line)
      // Containers named after their text only need their children if those add something.
      const plain = !!name && !child.shadowRoot && !child.querySelector(MEANINGFUL)
      if (!LEAF.has(role) && !plain) walk(child, depth + 1)
    }
  }

  emit(0, `page ${JSON.stringify(document.title)} — ${location.href}`)
  emit(0, `viewport ${innerWidth}×${innerHeight}, scrolled to ${Math.round(scrollX)},${Math.round(scrollY)} of ${document.documentElement.scrollWidth}×${document.documentElement.scrollHeight}`)
  if (document.body) walk(document.body, 0)
  if (truncated) lines.push('… (truncated; scroll or use preview_eval for the rest)')
  return lines.join('\n')
}

/**
 * Find the element for a tool call, scroll it into view, and return where to click it.
 * `focus` focuses it; `replace` also empties a text field so typed text replaces its value.
 */
export function pageLocate(target: Target, mode: 'none' | 'focus' | 'replace'): Located {
  const describe = (el: Element) => {
    const text = ((el as HTMLElement).innerText || el.getAttribute('aria-label') || (el as HTMLInputElement).placeholder || '')
      .replace(/\s+/g, ' ')
      .trim()
    const id = el.id ? `#${el.id}` : ''
    return `<${el.tagName.toLowerCase()}${id}>${text ? ` "${text.length > 60 ? `${text.slice(0, 59)}…` : text}"` : ''}`
  }

  let el: Element | null | undefined = null
  if (target.ref) {
    const refs = (window as unknown as { __vibecanvasRefs?: Map<string, Element> }).__vibecanvasRefs
    el = refs?.get(target.ref)
    if (!el || !el.isConnected) return { error: `No element with ref ${target.ref} on the page any more. Take a new preview_snapshot.` }
  } else if (target.selector) {
    try {
      el = document.querySelector(target.selector)
    } catch (err) {
      return { error: `Invalid selector: ${String(err)}` }
    }
    if (!el) return { error: `No element matches ${target.selector}` }
  } else if (target.text) {
    const wanted = target.text.toLowerCase().replace(/\s+/g, ' ').trim()
    const matches: Element[] = []
    for (const candidate of document.body.querySelectorAll('*')) {
      const text = ((candidate as HTMLElement).innerText ?? '').toLowerCase().replace(/\s+/g, ' ').trim()
      const label = String(candidate.getAttribute('aria-label') ?? (candidate as HTMLInputElement).value ?? '').toLowerCase()
      if ((text.includes(wanted) || label === wanted) && candidate.checkVisibility?.()) matches.push(candidate)
    }
    // The innermost match, preferring exact text and then interactive ancestors.
    const innermost = matches.filter((m) => !matches.some((o) => o !== m && m.contains(o)))
    const exact = innermost.find((m) => ((m as HTMLElement).innerText ?? '').toLowerCase().replace(/\s+/g, ' ').trim() === wanted)
    const found = exact ?? innermost[0]
    el = found?.closest('a,button,[role=button],[role=link],[role=tab],[role=menuitem],label,summary,input,select,textarea') ?? found
    if (!el) return { error: `No visible element contains the text "${target.text}"` }
  } else {
    return { error: 'Pass ref (from preview_snapshot), selector, or text.' }
  }

  el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' as ScrollBehavior })
  const rect = el.getBoundingClientRect()
  if (rect.width === 0 && rect.height === 0) return { error: `${describe(el)} has no size on the page (hidden?)` }
  const x = Math.round(Math.min(Math.max(rect.left + rect.width / 2, 0), innerWidth - 1))
  const y = Math.round(Math.min(Math.max(rect.top + rect.height / 2, 0), innerHeight - 1))
  const top = document.elementFromPoint(x, y)
  const coveredBy = top && top !== el && !el.contains(top) && !top.contains(el) ? describe(top) : undefined

  let kind: 'select' | 'checkable' | 'text' | 'other' = 'other'
  if (el instanceof HTMLSelectElement) kind = 'select'
  else if (el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio')) kind = 'checkable'
  else if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || (el as HTMLElement).isContentEditable) kind = 'text'

  if (mode === 'replace' && kind === 'text') {
    ;(el as HTMLElement).focus()
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
      // The native setter, so frameworks that track the value (React) see the change.
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
      Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(el, '')
      el.dispatchEvent(new Event('input', { bubbles: true }))
    } else {
      const range = document.createRange()
      range.selectNodeContents(el)
      const selection = getSelection()
      selection?.removeAllRanges()
      selection?.addRange(range)
    }
  } else if (mode !== 'none' && el instanceof HTMLElement) {
    el.focus()
  }
  ;(window as unknown as { __vibecanvasTarget: Element }).__vibecanvasTarget = el
  return { x, y, description: describe(el), coveredBy, kind }
}

/** Pick an option in the <select> found by the last pageLocate call. */
export function pageSelectOption(value: string): { error?: string; selected?: string } {
  const el = (window as unknown as { __vibecanvasTarget?: Element }).__vibecanvasTarget
  if (!(el instanceof HTMLSelectElement)) return { error: 'Not a <select> element' }
  const wanted = value.toLowerCase().trim()
  const option = [...el.options].find((o) => o.value === value) ?? [...el.options].find((o) => o.text.toLowerCase().trim() === wanted)
  if (!option) return { error: `No option "${value}". Options: ${[...el.options].map((o) => JSON.stringify(o.text)).join(', ')}` }
  el.value = option.value
  el.dispatchEvent(new Event('input', { bubbles: true }))
  el.dispatchEvent(new Event('change', { bubbles: true }))
  return { selected: option.text }
}

/** Serialize whatever an evaluated expression returned, without throwing on DOM nodes or cycles. */
export function pageSerialize(value: unknown, maxChars: number): string {
  if (value === undefined) return 'undefined'
  if (typeof value === 'string') return value.length > maxChars ? `${value.slice(0, maxChars)}… (truncated)` : value
  const seen = new WeakSet<object>()
  const text = JSON.stringify(
    value,
    (_key, v) => {
      if (typeof v === 'function') return `[Function ${v.name || 'anonymous'}]`
      if (typeof v === 'bigint') return `${v}n`
      if (v instanceof Element) return `<${v.tagName.toLowerCase()}${v.id ? `#${v.id}` : ''}>`
      if (v instanceof Map) return Object.fromEntries(v)
      if (v instanceof Set) return [...v]
      if (v instanceof Error) return `${v.name}: ${v.message}`
      if (v && typeof v === 'object') {
        if (seen.has(v)) return '[Circular]'
        seen.add(v)
      }
      return v
    },
    2
  )
  const out = text ?? String(value)
  return out.length > maxChars ? `${out.slice(0, maxChars)}… (truncated)` : out
}

/**
 * Type into the element found by the last pageLocate call (already emptied and focused).
 * insertText goes through the browser's editing pipeline, so frameworks see real input
 * events; setting the value directly is the fallback.
 */
export function pageInsertText(value: string): string {
  const el = (window as unknown as { __vibecanvasTarget?: HTMLElement }).__vibecanvasTarget
  if (!el) return ''
  el.focus()
  const field = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement ? el : null
  const inserted = value === '' || document.execCommand('insertText', false, value)
  if (field && (!inserted || field.value !== value)) {
    const proto = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(field, value)
    field.dispatchEvent(new Event('input', { bubbles: true }))
  }
  el.dispatchEvent(new Event('change', { bubbles: true }))
  return field ? field.value : el.innerText
}
