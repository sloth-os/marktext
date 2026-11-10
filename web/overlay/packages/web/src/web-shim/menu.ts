// HTML context menu replacement for Electron's native popup menus. The
// renderer serializes menu items (`ContextMenuItem` with ids, labels,
// checkboxes, submenus) and calls `window.electron.windowControl.popupMenu`.
// Electron then answers with `mt::menu::click {id}` / `mt::menu::closed`; the
// web build renders the same template as an HTML menu and emits the same
// events.

interface MenuItem {
  id?: string
  label?: string
  type?: string
  accelerator?: string
  enabled?: boolean
  checked?: boolean
  submenu?: MenuItem[]
}

let openMenu: HTMLElement | null = null
let closeHandler: (() => void) | null = null

const MENU_Z_INDEX = '2147483647'

export const closeWebMenu = (): void => {
  if (openMenu) {
    openMenu.remove()
    openMenu = null
  }
  if (closeHandler) {
    closeHandler()
    closeHandler = null
  }
}

const styleSheet = `
.web-menu {
  position: fixed;
  min-width: 180px;
  max-width: 320px;
  max-height: 70vh;
  overflow-y: auto;
  padding: 4px 0;
  margin: 0;
  background: var(--sideBarColor, #ffffff);
  color: var(--sideBarTextColor, #303133);
  border: 1px solid rgba(0, 0, 0, 0.15);
  border-radius: 6px;
  box-shadow: 0 6px 24px rgba(0, 0, 0, 0.18);
  font: 13px/1.4 "Segoe UI", "Helvetica Neue", Arial, sans-serif;
  user-select: none;
  z-index: ${MENU_Z_INDEX};
  list-style: none;
}
.web-menu-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 24px;
  padding: 6px 14px;
  cursor: pointer;
  white-space: nowrap;
}
.web-menu-item.disabled {
  color: rgba(128, 128, 128, 0.5);
  cursor: default;
}
.web-menu-item:not(.disabled):hover {
  background: var(--themeColor, #409eff);
  color: #fff;
}
.web-menu-item .web-menu-check {
  width: 16px;
  flex: none;
}
.web-menu-item .web-menu-label {
  flex: 1;
}
.web-menu-item .web-menu-accel {
  opacity: 0.55;
  font-size: 12px;
}
.web-menu-item .web-menu-arrow {
  opacity: 0.6;
  margin-left: 8px;
}
.web-menu-separator {
  height: 1px;
  margin: 4px 8px;
  background: rgba(128, 128, 128, 0.3);
}
.web-submenu {
  position: fixed;
  min-width: 160px;
  max-height: 60vh;
  overflow-y: auto;
  padding: 4px 0;
  margin: 0;
  background: var(--sideBarColor, #ffffff);
  color: var(--sideBarTextColor, #303133);
  border: 1px solid rgba(0, 0, 0, 0.15);
  border-radius: 6px;
  box-shadow: 0 6px 24px rgba(0, 0, 0, 0.18);
  font: 13px/1.4 "Segoe UI", "Helvetica Neue", Arial, sans-serif;
  user-select: none;
  z-index: ${MENU_Z_INDEX};
  list-style: none;
}
`

let styleElement: HTMLStyleElement | null = null
const ensureStyles = (): void => {
  if (styleElement) return
  styleElement = document.createElement('style')
  styleElement.id = 'web-menu-styles'
  styleElement.textContent = styleSheet
  document.head.appendChild(styleElement)
}

const buildMenu = (
  items: MenuItem[],
  onClick: (id: string) => void
): HTMLElement => {
  const list = document.createElement('ul')
  list.className = items === null ? 'web-menu' : 'web-submenu'
  for (const item of items) {
    if (item.type === 'separator') {
      const separator = document.createElement('li')
      separator.className = 'web-menu-separator'
      list.appendChild(separator)
      continue
    }
    const row = document.createElement('li')
    const disabled = item.enabled === false
    row.className = `web-menu-item${disabled ? ' disabled' : ''}`

    const check = document.createElement('span')
    check.className = 'web-menu-check'
    check.textContent = item.type === 'checkbox' || item.type === 'radio' ? (item.checked ? '✓' : '') : ''

    const label = document.createElement('span')
    label.className = 'web-menu-label'
    label.textContent = item.label ?? ''

    row.append(check, label)

    if (item.accelerator) {
      const accel = document.createElement('span')
      accel.className = 'web-menu-accel'
      accel.textContent = item.accelerator
      row.appendChild(accel)
    }
    if (item.submenu?.length) {
      const arrow = document.createElement('span')
      arrow.className = 'web-menu-arrow'
      arrow.textContent = '▸'
      row.appendChild(arrow)
    }

    if (!disabled) {
      if (item.submenu?.length) {
        row.addEventListener('mouseenter', () => {
          row.querySelector('.web-submenu')?.remove()
          const sub = buildMenu(item.submenu!, onClick)
          const rect = row.getBoundingClientRect()
          sub.style.left = `${rect.right}px`
          sub.style.top = `${rect.top}px`
          row.appendChild(sub)
        })
        row.addEventListener('mouseleave', () => {
          row.querySelector('.web-submenu')?.remove()
        })
      } else if (item.id) {
        row.addEventListener('click', (event) => {
          event.stopPropagation()
          onClick(item.id!)
          closeWebMenu()
        })
      }
    }
    list.appendChild(row)
  }
  return list
}

/** Shows the serialized context menu at a position and reports clicks. */
export const popupWebMenu = (
  template: MenuItem[],
  position: { x: number; y: number } | undefined,
  onClick: (id: string) => void,
  onClosed: () => void
): void => {
  ensureStyles()
  closeWebMenu()

  const menu = buildMenu(template, onClick)
  menu.className = 'web-menu'
  document.body.appendChild(menu)

  // Position at the cursor, flipping when overflowing the viewport.
  const rect = menu.getBoundingClientRect()
  let x = position?.x ?? 0
  let y = position?.y ?? 0
  if (x + rect.width > window.innerWidth) x = Math.max(0, window.innerWidth - rect.width - 8)
  if (y + rect.height > window.innerHeight) y = Math.max(0, window.innerHeight - rect.height - 8)
  menu.style.left = `${x}px`
  menu.style.top = `${y}px`

  openMenu = menu
  closeHandler = onClosed

  // Close on outside click, Escape, scroll or resize.
  setTimeout(() => {
    const onOutside = (event: MouseEvent): void => {
      if (!menu.contains(event.target as Node)) closeWebMenu()
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') closeWebMenu()
    }
    const onAnyScroll = (): void => closeWebMenu()
    document.addEventListener('mousedown', onOutside, true)
    document.addEventListener('keydown', onKey, true)
    window.addEventListener('resize', onAnyScroll)
    window.addEventListener('scroll', onAnyScroll, true)
    const previousClose = closeHandler
    closeHandler = () => {
      document.removeEventListener('mousedown', onOutside, true)
      document.removeEventListener('keydown', onKey, true)
      window.removeEventListener('resize', onAnyScroll)
      window.removeEventListener('scroll', onAnyScroll, true)
      previousClose?.()
    }
  }, 0)
}
