export async function resolve(specifier, context, nextResolve) {
  // Pass through: bare specifiers, absolute, node: builtins, already-has-extension, data:
  if (
    specifier.startsWith('node:') ||
    specifier.startsWith('file:') ||
    specifier.startsWith('/') ||
    specifier.startsWith('data:') ||
    /^(https?:|@)/.test(specifier) ||
    /\.[a-zA-Z0-9]+$/.test(specifier)
  ) {
    return nextResolve(specifier, context);
  }
  // relative/absolute extensionless -> try .ts
  try {
    return await nextResolve(specifier + '.ts', context);
  } catch (e) {
    try {
      return await nextResolve(specifier + '.mjs', context);
    } catch {
      return nextResolve(specifier, context);
    }
  }
}
