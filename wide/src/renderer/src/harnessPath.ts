export function displayHarnessPath(path: string) {
  const normalized = path.replaceAll('\\', '/')
  const relative = normalized.match(/(?:^|\/)(\.(?:claude|factory|codex|agents|dsh|pi|config\/opencode)(?:\/.*)?$)/i)?.[1]
  return relative ? `~/${relative}` : normalized
}
