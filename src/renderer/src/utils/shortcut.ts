const isMac = navigator.platform.toLowerCase().includes('mac')

const tokenMap: Record<string, string> = {
  commandorcontrol: isMac ? 'Cmd' : 'Ctrl',
  command: 'Cmd',
  control: 'Ctrl',
  option: 'Alt',
  return: 'Enter',
  escape: 'Esc'
}

export const formatShortcutForDisplay = (shortcut: string) => {
  if (!shortcut) return shortcut

  return shortcut
    .split('+')
    .map((token) => token.trim())
    .filter(Boolean)
    .map((token) => tokenMap[token.toLowerCase()] ?? token)
    .join('+')
}
