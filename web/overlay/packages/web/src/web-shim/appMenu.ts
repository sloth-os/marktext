// Application menu template for the web build: mirrors the desktop's
// hamburger menu (File/Edit/View/Paragraph) but routes everything through
// `mt::execute-command-by-id`, which the renderer's command center executes.
// Menu labels use the same i18n keys as the desktop menus via the renderer's
// i18n instance.

interface AppMenuItem {
  id?: string
  label?: string
  type?: string
  accelerator?: string
  enabled?: boolean
  submenu?: AppMenuItem[]
}

/** Builds the File/Edit/View menu tree with current keybinding accelerators. */
export const getApplicationMenuTemplate = (): AppMenuItem[] => {
  // Import lazily to avoid a cycle with the ipc module; the i18n module
  // returns the already-configured renderer instance.
  const t = (key: string, ...args: unknown[]): string => {
    try {
      // The renderer's i18n exports `t` synchronously.
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const i18n = (window as unknown as { __mtI18n?: { t: (k: string, ...a: unknown[]) => string } }).__mtI18n
      return i18n ? i18n.t(key, ...args) : key
    } catch {
      return key
    }
  }
  void t

  const keybinding = (id: string): string | undefined => {
    const bindings = (window as unknown as { __mtKeybindings?: Record<string, string> }).__mtKeybindings
    return bindings?.[id] || undefined
  }

  const item = (id: string, label: string): AppMenuItem => ({
    id,
    label,
    accelerator: keybinding(id)
  })

  return [
    {
      label: 'File',
      submenu: [
        item('file.new-tab', 'New Tab'),
        item('file.save', 'Save'),
        item('file.save-as', 'Save As…'),
        { type: 'separator' },
        item('file.export-file.pdf', 'Export as PDF'),
        item('file.print', 'Print…'),
        { type: 'separator' },
        item('file.open-file', 'Open File…'),
        item('file.open-folder', 'Open Folder…'),
        { type: 'separator' },
        { id: 'mt::open-settings', label: 'Preferences…' }
      ]
    },
    {
      label: 'Edit',
      submenu: [
        item('edit.undo', 'Undo'),
        item('edit.redo', 'Redo'),
        { type: 'separator' },
        item('edit.cut', 'Cut'),
        item('edit.copy', 'Copy'),
        item('edit.paste', 'Paste'),
        { type: 'separator' },
        item('edit.copy-as-rich', 'Copy as Rich'),
        item('edit.copy-as-html', 'Copy as HTML'),
        item('edit.paste-as-plaintext', 'Paste as Plain Text'),
        { type: 'separator' },
        item('edit.select-all', 'Select All'),
        { type: 'separator' },
        item('edit.find', 'Find'),
        item('edit.find-next', 'Find Next'),
        item('edit.find-previous', 'Find Previous'),
        item('edit.replace', 'Replace'),
        item('edit.find-in-folder', 'Find in Folder'),
        { type: 'separator' },
        item('edit.duplicate', 'Duplicate'),
        item('edit.create-paragraph', 'Create Paragraph'),
        item('edit.delete-paragraph', 'Delete Paragraph')
      ]
    },
    {
      label: 'View',
      submenu: [
        item('view.toggle-source-code-mode', 'Source Code Mode'),
        item('view.toggle-typewriter-mode', 'Typewriter Mode'),
        item('view.toggle-focus-mode', 'Focus Mode'),
        { type: 'separator' },
        item('view.toggle-sidebar', 'Toggle Sidebar'),
        item('view.toggle-tabbar', 'Toggle Tab Bar'),
        item('view.toggle-toc', 'Toggle Outline'),
        { type: 'separator' },
        // Command palette opens via its dedicated bus event, not a command id.
        { id: 'mt::show-command-palette', label: 'Command Palette' }
      ]
    },
    {
      label: 'Paragraph',
      submenu: [
        item('paragraph.heading-1', 'Heading 1'),
        item('paragraph.heading-2', 'Heading 2'),
        item('paragraph.heading-3', 'Heading 3'),
        item('paragraph.heading-4', 'Heading 4'),
        item('paragraph.heading-5', 'Heading 5'),
        item('paragraph.heading-6', 'Heading 6'),
        { type: 'separator' },
        item('paragraph.upgrade-heading', 'Upgrade Heading'),
        item('paragraph.degrade-heading', 'Degrade Heading'),
        { type: 'separator' },
        item('paragraph.table', 'Table'),
        item('paragraph.code-fence', 'Code Fences'),
        item('paragraph.quote-block', 'Quote Block'),
        { type: 'separator' },
        item('paragraph.bullet-list', 'Bullet List'),
        item('paragraph.order-list', 'Ordered List'),
        item('paragraph.task-list', 'Task List')
      ]
    }
  ]
}
